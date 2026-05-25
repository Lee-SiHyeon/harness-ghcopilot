# `.github/` Harness — 요구사항 명세

> 본 문서는 현재 구현(`.github/` 디렉토리, 178+92 테스트 통과 상태)을 역으로 분석해 추출한 요구사항이다. 새 기능을 더할 때 이 문서의 항목 번호를 인용한다. 구현이 문서를 앞서면 문서를 갱신한다.

---

## 1. 개요

### 1.1 목적
GitHub Copilot Chat(VS Code) 환경에서 멀티에이전트 협업을 자동화하고, 동일 파이프라인을 VS Code 밖(CI·서버)에서도 재현 가능한 형태로 운영한다.

### 1.2 핵심 가치
| # | 가치 | 어떻게 달성하나 |
|---|---|---|
| V1 | 일관된 작업 흐름 | Maestro 오케스트레이션이 모든 요청을 분류·라우팅하고 사용자가 동일한 형식의 응답을 받는다 |
| V2 | 자기수정 방지 | Maestro는 직접 코드를 쓰지 않고 Implementer에게 위임한다 (file-guard로 강제) |
| V3 | 검증 강제 | 코드 변경 → Tester → Reviewer → Critic 순서를 어길 수 없다 |
| V4 | 사실 기반 답변 | 라이브러리 관련 답변은 Context7 공식 문서 조회를 거친다 |
| V5 | 자기개선 루프 | 회고가 자동 기록되고 미해결 개선 항목이 다음 세션에 다시 노출된다 |
| V6 | 런타임 독립성 | 같은 파이프라인 정의가 Copilot 훅과 LangGraph에서 모두 동작한다 |

### 1.3 이해관계자
- **Primary user**: VS Code + GitHub Copilot Chat 사용자 (개인 개발자 / 본인)
- **Secondary user**: CI 환경에서 동일 파이프라인을 돌리려는 외부 프로세스
- **Maintainer**: 본 하네스를 직접 유지보수하는 사용자

---

## 2. 시스템 컨텍스트

### 2.1 런타임 환경
- VS Code Stable 또는 Insiders + GitHub Copilot Chat (Custom Agent Hooks 활성화 가능 채널)
- Node.js ≥ 20 (훅·MCP server)
- Python ≥ 3.11 (LangGraph harness, 선택)
- OS: Windows 11 (개발 환경), 단 경로 처리는 POSIX 호환

### 2.2 외부 의존성
| 항목 | 용도 | 필수 여부 |
|---|---|---|
| GitHub Copilot Chat | 채팅 UI, runSubagent 실행 | 필수 (훅 경로) |
| MCP SDK `@modelcontextprotocol/sdk` | 로컬 MCP server | 필수 (mcp-server 빌드 시) |
| GitHub Models API (PAT) | gpt-4o-mini 분류기 | 선택 (없으면 regex 폴백) |
| OpenCode Go API | (옵션 분류 백엔드) | 선택 |
| Context7 MCP | 라이브러리 문서 조회 | 권장 (V4 가치 충족) |
| `langgraph`, `langchain-core`, `langchain-mcp-adapters` | LangGraph harness | 선택 (CI 경로) |

---

## 3. 기능 요구사항

### 3.1 오케스트레이션 (Maestro)
- **FR-1.1** Maestro는 모든 사용자 요청을 받아 단일 진입점으로 처리한다. 작업 유형을 분류하고 파이프라인을 결정한다.
- **FR-1.2** Maestro는 직접 코드·파일을 수정하지 않는다. 모든 변경은 Implementer 서브에이전트에 위임한다. *예외*: `.github/logs/` 하위 로그 파일 (단, `retrospective-history.md`는 Implementer 경유 필수).
- **FR-1.3** Maestro 자신의 정의 파일(`agents/maestro.agent.md`)은 Maestro 본인만 수정할 수 있다. 다른 에이전트는 읽기만 가능.
- **FR-1.4** 사용자가 모델을 명시하지 않으면 Maestro는 서브에이전트 호출 시 `model` 파라미터를 지정하지 않는다 (에이전트 frontmatter 기본값 사용).
- **FR-1.5** `runSubagent` 도구가 비활성화되어 있으면 Maestro는 즉시 중단하고 사용자에게 도구 활성화를 안내한다 (직접 구현 모드로 폴백 금지).

### 3.2 파이프라인 분류 및 라우팅
- **FR-2.1** 사용자 프롬프트 제출 시 자동으로 작업 유형을 10가지 중 하나로 분류한다: `implement`, `fix`, `investigate`, `review`, `document`, `plan`, `question`, `query`, `release`, `scout`, `scout_loop`.
- **FR-2.2** 분류는 GitHub Models API(gpt-4o-mini) → regex 폴백 2단계로 동작한다. `GITHUB_PAT` 미설정 시 regex로 동작하고 사용자에게 안내한다.
- **FR-2.3** 분류 결과는 `meta/pipelines.json`(SSOT)에 정의된 10개 파이프라인(A~J) 중 하나의 step 목록으로 매핑된다.
- **FR-2.4** Maestro는 분류 결과를 응답 첫 줄에 의무 출력한다 (`🎯 작업 유형 / 📋 파이프라인 / 🔍 분류 방식`).
- **FR-2.5** Maestro는 `pipelines.json`에 없는 임의 파이프라인을 선언할 수 없다 (`buildPipelineEnforcementBlock`이 허용 목록을 매 요청 주입).
- **FR-2.6** 복잡도 ≥ 8 또는 보안 민감 + 복잡도 ≥ 6 시 HITL gate가 발동해 사용자 확인을 요구한다.

### 3.3 11개 서브에이전트
파이프라인을 구성하는 단위. 각 에이전트는 `.agent.md` 파일에 frontmatter(tools, model, handoffs)와 시스템 프롬프트를 정의한다.

| 에이전트 | 권한 | 책임 |
|---|---|---|
| Planner | read, search | 구현 계획서 작성 (코드 수정 금지) |
| Implementer | edit, execute | 계획 기반 코드 작성 |
| Tester | execute | 테스트 실행, `test-evidence.json` 기록 (코드 수정 금지) |
| Reviewer | read | OWASP·품질 검토 (코드 수정 금지) |
| Critic | read | H1~H6 파이프라인 준수 검증 |
| Investigator | read, search | 근본 원인 분석 (코드 수정 금지) |
| Documenter | edit | 문서 작성 (5단계 포맷) |
| Context7 Docs Agent | mcp | 라이브러리 공식 문서 조회 |
| Scout | read, web | 외부 트렌드·자기개선 후보 발굴 |
| Release | execute | 커밋·태그·배포 |
| Maestro | agent | 오케스트레이션 전용 (서브에이전트 호출만) |

- **FR-3.1** 모든 에이전트는 SubagentStart 시 자신의 역할에 맞는 todo 가이드를 자동 수신한다.
- **FR-3.2** 읽기 전용 에이전트(Investigator, Reviewer, Planner, Scout)가 로그 외 파일을 수정하려 하면 file-guard가 soft warn을 띄운다.
- **FR-3.3** `agent_type === 'default'`(VS Code builtin sentinel)와 `^toolu_` 접두 ID(Anthropic Tool Call ID)는 에이전트 이름으로 인정하지 않고 폐기한다.

### 3.4 파이프라인 실행 규칙
- **FR-4.1** `Planner → Implementer → Reviewer → Critic → Release` 순서를 어기지 않는다.
- **FR-4.2** Tester FAIL 시 Implementer 재호출, 최대 3회 반복 후 사용자 판단 위임 (`maxTesterRetries` from `pipelines.json`).
- **FR-4.3** Reviewer가 크리티컬 이슈 발견 시 Implementer 재호출, 최대 3회 반복 (`maxReviewerRetries`).
- **FR-4.4** Implementer 2회 이상 호출되면 마지막 호출 이후 Reviewer가 반드시 한 번 더 실행돼야 한다 (`implReviewGap` 검증).
- **FR-4.5** intent가 `implement`/`fix`이면 Tester가 누락될 수 없다 (`absentAgent` 검증).
- **FR-4.6** `.github/agents/`, `.github/hooks/` 변경이 포함되면 파일 확장자와 무관하게 `tests/maestro-suite.test.js` 실행이 Tester 의무에 포함된다.
- **FR-4.7** 병렬 실행이 가능한 독립 Implementer 호출 2개 이상은 반드시 병렬로 처리한다 (순차 호출은 효율 위반).

### 3.5 안전 가드 (PreToolUse)
- **FR-5.1** 셸 명령어(`run_in_terminal`, `execute_command`) 호출 전 `meta/guards.json`의 destructive 패턴(`appliesTo: js` 포함)으로 검사한다. 매치 시 `decision: ask` 반환.
- **FR-5.2** `git push --force-with-lease`는 destructive 패턴에서 명시적으로 제외된다 (negative lookahead).
- **FR-5.3** 파일 수정 도구 호출 전 다음을 검사한다:
  - 워크스페이스 외부 경로 → ask
  - `.github/{hooks,agents,workflows,skills}/` → ask
  - `maestro.agent.md` → 호출자가 Maestro 본인이고 subagent context가 아닐 때만 ask, 그 외엔 deny
  - Maestro가 logs 외부를 수정 시도 → deny (`maestro_direct_impl`)
  - `.env*`, `*.pem`, `*.key`, `*.cert`, `*.p12`, `*.pfx`, `*.jks`, `credentials`, `.secret` → ask
  - `apply_patch`로 경로 파싱 실패 → deny (어떤 파일이 바뀌는지 모름)
- **FR-5.4** 보호 규칙·민감 확장자·lock 파일·destructive 패턴은 모두 `meta/guards.json` SSOT에서 로드된다. 인라인 하드코딩 금지.
- **FR-5.5** 가드 내부 오류 시 안전하게 deny한다 (fail-closed).

### 3.6 라이브러리 문서 조회 강제 (Context7)
- **FR-6.1** 프롬프트에서 라이브러리/프레임워크 키워드(현재 8종: Next.js, React, Prisma, Supabase, Express, Tailwind, Vue, Docker)가 감지되면 `Context7 Docs Agent`를 파이프라인 첫 단계로 자동 prepend한다 (이미 포함되면 중복 추가하지 않음).
- **FR-6.2** 스택 감지 시 "라이브러리 감지 — Context7 호출 필수" 강조 블록을 Maestro 컨텍스트에 주입한다 (단순 질의도 Context7 우회 금지).
- **FR-6.3** 학습 데이터의 옛 API로 추측해 답하는 것은 금지한다.

### 3.7 회고 및 자기개선 루프
- **FR-7.1** complexity ≥ 3인 파이프라인 완료 시 회고 작성이 의무다.
- **FR-7.2** SubagentStop 이벤트마다 `retrospective-trigger.js`가 실행 데이터(skippedAgents, implReviewGap, absentAgent 등)를 자동 감지하고 `retrospective-draft.json`의 `actionItems`에 append한다.
- **FR-7.3** Maestro는 최신 회고 항목의 `자기비평`/`다음 번 개선` 필드를 채워야 한다 (이 두 필드 미작성은 회고 미완료).
- **FR-7.4** 회고 본문은 `logs/retro.jsonl`(append-only)에 기록하고, `retro-renderer.js`가 이를 `logs/retrospective-history.md`로 렌더링한다 (`history.md`는 자동 생성 — 직접 편집 금지).
- **FR-7.5** 같은 문제가 회고에 2회 이상 등장하면 `반복 패턴` 섹션이 자동 갱신된다.
- **FR-7.6** 미해결 `actionItems`가 존재하면 다음 사용자 요청 시 `[⚠️ 미해결 개선 항목]` 블록이 Maestro 컨텍스트에 자동 주입된다. Maestro는 사용자에게 묻지 않고 fix 파이프라인으로 즉시 처리한다.
- **FR-7.7** `retroImprovement` source의 actionItem은 사용자의 현재 요청보다 항상 선행 처리된다.

### 3.8 상태 관리 (MCP server)
- **FR-8.1** 로컬 MCP server(`mcp-server/dist/index.js`)가 stdio로 다음 도구를 노출한다:
  - `todo-*`: `logs/current-todos.json` 읽기/쓰기
  - `pipeline-*`: `pipeline.jsonl`, `subagent-flow.jsonl` 조회
  - `actionitems-*`: `retrospective-draft.json`의 actionItems 조회/수정
  - `testgate-*`: `test-evidence.json`, `test-gate-state.json`
  - `retro-*`: `retro.jsonl`, `retrospective-history.md`
- **FR-8.2** 모든 상태 변경은 `mcp-server/state-lib/*.js`의 함수를 경유한다 (훅과 MCP server가 같은 라이브러리를 공유).

### 3.9 컨텍스트 압축 보존
- **FR-9.1** PreCompact 이벤트 시 `precompact-save.js`가 진행 중 todo, 회고 초안, 파이프라인 상태를 저장한다.
- **FR-9.2** 다음 세션의 UserPromptSubmit 시 저장된 상태가 `formatResumeBlock`을 통해 사용자 메시지에 prepend된다.

### 3.10 LangGraph 대체 런타임 (선택)
- **FR-10.1** `langgraph-harness/`는 VS Code 없이도 동일 파이프라인을 실행할 수 있다 (`build_pipeline_graph(pipeline_id)`).
- **FR-10.2** LangGraph harness는 같은 `meta/pipelines.json`(파이프라인 정의)과 `meta/guards.json`(가드)을 읽는다. 별도 정의 금지.
- **FR-10.3** LangGraph harness는 같은 `agents/*.agent.md` 파일에서 시스템 프롬프트를 로드한다.
- **FR-10.4** 실행 결과는 같은 `logs/pipeline.jsonl`과 `logs/retro.jsonl`에 기록된다.
- **FR-10.5** LangGraph harness는 훅 시스템을 호출하지 않는다 (반대도 성립). 두 시스템은 데이터 파일로만 연결된다.

### 3.11 보안 / Prompt Injection 방지
- **FR-11.1** 외부 입력(사용자 프롬프트, 상위 컨텍스트)은 `wrapUntrusted()`로 untrusted fence 안에 격리한다.
- **FR-11.2** Backtick fence-break payload는 fence를 탈출할 수 없어야 한다 (TC 회귀로 보장).
- **FR-11.3** 민감정보(API key, password, JWT 등)는 `audit.summarize()`로 redaction 후 로깅한다.
- **FR-11.4** Scout가 가져온 외부 웹/repo 내용은 untrusted로 취급하고 그 안의 instruction은 실행하지 않는다.

### 3.12 비용 / 모델 제어
- **FR-12.1** `runSubagent` 호출 시 cost tier 초과 모델은 자동 회피한다 (`cost-tier-exceeded.json` TTL 24h).
- **FR-12.2** 사용자가 모델을 명시(Gemini, GPT-5, Claude, Sonnet, Opus 등 키워드)한 경우 model-guard가 이를 감지해 보존한다.

---

## 4. 비기능 요구사항

### 4.1 성능
- **NFR-1** UserPromptSubmit 훅 응답 ≤ 5초 (`hooks/maestro-routing.json` timeout). LLM 분류 timeout 8초, regex 폴백은 즉시.
- **NFR-2** PreToolUse 가드 응답 ≤ 3초.
- **NFR-3** SubagentStart/Stop 로거 응답 ≤ 3~5초.
- **NFR-4** stdin payload 한도 64KB (DoS 방어).

### 4.2 가용성 / Fail-safety
- **NFR-5** 모든 훅은 내부 오류 시 `{continue: true}` 또는 안전한 default를 반환해 사용자 채팅을 막지 않는다. **단** file-guard 내부 오류는 deny (fail-closed).
- **NFR-6** 분류기 LLM 실패 시 regex로 폴백한다. regex 실패 시 `defaultPipeline`("A") 사용.
- **NFR-7** `pipelines.json`/`guards.json` 로드 실패 시 빈 fallback 사용 (시스템은 동작하되 기능 축소).

### 4.3 호환성
- **NFR-8** 훅 stdin과 환경변수 두 경로 모두 지원 (VS Code Custom Agent Hooks 진화 대비).
- **NFR-9** Windows 경로(`\\`)와 POSIX 경로(`/`)를 모두 정규화 처리.
- **NFR-10** Node.js ≥ 20, Python ≥ 3.11 (옵셔널 의존성은 모두 graceful degrade).

### 4.4 관측성
- **NFR-11** 모든 훅 이벤트는 `hook-audit.jsonl`에 기록된다 (sequence 단조 증가).
- **NFR-12** Subagent lifecycle은 `subagent-flow.jsonl`에 `correlationId`로 start-stop 매칭된다.
- **NFR-13** 도구 호출 통계는 `tool-metrics.jsonl`, `tool-stats.json`에 누적된다.
- **NFR-14** Maestro session은 세션당 1회 `MaestroSessionStart` 이벤트로 표시된다.

### 4.5 테스트성
- **NFR-15** maestro-suite (Node) ≥ 178 TC PASS, langgraph-harness (Python) ≥ 92 TC PASS를 항상 유지한다.
- **NFR-16** `.js` 모듈을 require하는 TC는 대상 모듈에 `require.main === module` 가드가 있는지 사전 점검한다 (top-level 부작용으로 운영 로그 오염 방지).
- **NFR-17** Planner가 위 점검을 계획서에 명시한다 (`agents/planner.agent.md` 체크리스트).

### 4.6 유지보수성
- **NFR-18** 같은 판별 로직은 양쪽 언어/파일에 중복 정의하지 않고 공용 모듈로 추출한다 (`hooks/scripts/shared-utils.js`, `langgraph-harness/tools/guards_loader.py`).
- **NFR-19** 파이프라인·가드 등 정적 데이터는 JSON SSOT(`meta/*.json`)로 일원화한다.

---

## 5. 데이터 모델 / SSOT

| 파일 | 종류 | 소유자 | 소비자 |
|---|---|---|---|
| `meta/pipelines.json` | SSOT | 사람 (수동 편집) | 훅 router, LangGraph supervisor, output-builder enforcement |
| `meta/guards.json` | SSOT | 사람 (수동 편집) | 훅 safety/file-guard, PY safety_guard/file_guard |
| `agents/*.agent.md` | SSOT | 사람 (Maestro는 자기 파일만) | 훅 todo-inject, LangGraph nodes.base |
| `logs/retro.jsonl` | append-only | 훅 retrospective-trigger, Maestro | retro-renderer |
| `logs/retrospective-history.md` | derived | retro-renderer | 사람 (읽기 전용) |
| `logs/retrospective-draft.json` | mutable | 훅 retrospective-trigger, retro-improvement-parser, Maestro | maestro-router (actionItems 주입) |
| `logs/pipeline.jsonl` | append-only | 훅 pipeline-logger, LangGraph callback | MCP pipeline-tools |
| `logs/subagent-flow.jsonl` | append-only | 훅 stop-logger, todo-inject | MCP pipeline-tools, retrospective-trigger |
| `logs/test-evidence.json` | mutable | Tester 에이전트 | Reviewer (0번 체크), Critic |
| `logs/test-gate-state.json` | mutable | 훅 test-gate | Reviewer (`requiredSince` 비교) |
| `logs/current-todos.json` | mutable | Copilot todo 도구, MCP | maestro-router (인터럽트 감지) |
| `logs/current-intent.json` | mutable | maestro-router | file-guard (read-only nah pattern) |
| `logs/cost-tier-exceeded.json` | TTL 24h | 훅 model-unavailability-tracker | maestro-router 안내 |
| `logs/last-subagent-start.json` | stack per agent (max 20) | todo-inject | stop-logger (correlation) |
| `logs/last-maestro-session.json` | mutable | maestro-router | 동일 (세션 변경 감지) |
| `logs/hook-audit.jsonl` | append-only | 모든 훅 | 사람 (감사 추적) |

---

## 6. 가정 및 제약

- **C-1** Custom Agent Hooks 기능이 동작하는 VS Code Copilot Chat 채널을 사용한다. 미지원 환경에서는 훅이 fire되지 않아 시스템 핵심 기능이 무력화된다.
- **C-2** 워크스페이스 루트는 `.github/`의 부모 디렉토리여야 한다 (현재 `C:\Users\dlxog\projects\`). 다른 루트에서 열면 훅이 .github를 찾지 못한다.
- **C-3** MCP server는 VS Code 시작 시 자동 spawn된다. 빌드(`mcp-server/dist/`)가 최신 상태여야 한다.
- **C-4** `runSubagent` 도구가 사용자 채팅 도구 picker에서 활성화돼 있어야 Maestro 오케스트레이션이 동작한다.
- **C-5** 한 워크스페이스에서 동시에 훅 경로와 LangGraph 경로를 같은 작업으로 돌리지 않는다 (logs 충돌).

---

## 7. 범위 외 (Out of Scope)

- 다중 사용자 협업 (현 시스템은 1인 개발자 가정)
- 클라우드 호스팅 / 서버리스 배포
- Web UI (모든 UX는 VS Code Copilot Chat 안에서)
- Maestro의 자기수정 외 동적 에이전트 추가/제거 (런타임에 .agent.md를 동적으로 만들지 않는다)
- 영구 메모리 (메모리는 retrospective-history.md 등 파일 기반만)

---

## 8. 추적성 매트릭스 (요약)

| 요구 | 주요 구현 파일 | 회귀 TC |
|---|---|---|
| FR-1.2, FR-1.3 (Maestro 자기수정) | `hooks/scripts/file-guard.js`, `meta/guards.json` | tc-153, tc-154 |
| FR-2.2 (LLM→regex 2단계) | `hooks/scripts/router/classifier.js` | tc-141~148 |
| FR-2.4 (의무 헤더) | `hooks/scripts/router/output-builder.js` | tc-149, tc-150 |
| FR-2.5 (파이프라인 SSOT 강제) | `hooks/scripts/router/output-builder.js` `buildPipelineEnforcementBlock` | (구현 후 추가 필요) |
| FR-3.3 (sentinel 필터) | `shared-utils.js isToolCallId`, agent_type=='default' 분기 | tc-168, tc-169 |
| FR-4.4 (implReviewGap) | `retrospective-trigger.js` | tc-162, tc-163, tc-167 |
| FR-4.5 (absentAgent) | `retrospective-trigger.js` | tc-160, tc-161 |
| FR-5.4 (가드 SSOT) | `safety-guard.js`, `file-guard.js`, `shared-utils.js loadGuards/getDestructivePatterns` | tc-129, tc-174~176 |
| FR-6.1, FR-6.2 (Context7 강제) | `output-builder.js ensureContext7InPipeline / buildContext7EnforcementBlock` | tc-170~173 |
| FR-7.6 (actionItems 자동 주입) | `router/retro-loaders.js`, `maestro-router.js` | tc-055, tc-056 |
| FR-10.1~10.4 (LangGraph 대체) | `langgraph-harness/graph/*`, `nodes/*`, `callbacks/*`, `tools/*` | test_builder, test_state, test_guards, test_guards_loader |
| FR-11.1, FR-11.2 (untrusted fence) | `router/env-utils.js wrapUntrusted` | tc-146, tc-147, tc-148 |

---

## 9. 변경 이력
| 일자 | 변경 |
|---|---|
| 2026-05-25 | 초안 작성 — 현재 구현 상태(178+92 TC PASS)를 역으로 분석해 PRD/SRS 형식으로 정리 |
