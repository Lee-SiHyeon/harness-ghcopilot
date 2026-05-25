# Maestro Chat — VS Code Extension

`.github/` 하네스를 위한 ChatParticipant `@maestro`.
훅 주입 방식(LLM이 무시 가능)의 한계를 우회해, 분류 배지를 **UI에 직접 스트리밍**한다.

## 왜 만들었나

기존 hook-based 시스템은 `modifiedParameters.userMessage`로 헤더를 주입하지만, LLM이 이를 응답에 포함할지는 확률적이다 (실제로 `📋 파이프라인: 직접 답변` 같은 H1 위반 사례 발생). VS Code Extension은 `ChatResponseStream.markdown()`으로 LLM과 무관하게 UI에 직접 쓸 수 있어 100% 보장된다.

## Phase 진행

| Phase | 상태 |
|---|---|
| **0** ChatParticipant 등록, 배지 강제 출력, vscode.lm 호출 | ✅ |
| **1** 사용자 시나리오 대응(host 프로젝트 / standalone clone) + 설정 + F5 디버그 | ✅ |
| **2** 멀티 에이전트 순차 실행기 + state TS 레이어 + agent loader | ✅ |
| **3** 사이드바 UI + 상태바 + GITHUB_PAT 편집 + vscode.lm 도구 등록(가드 통합) | ✅ |
| **3.5** executor tool-calling + 파일 변경 test-gate + retro/actionItems 기록 | ✅ |
| **4** Tester FAIL → Implementer 재시도 루프 + Release test gate | ✅ |
| **5** extension TS router 기본화, legacy hook router는 fallback | ✅ |
| **6** todo/precompact/actionItems/retro hook 기능 extension 흡수 | ✅ |
| **7** MCP optional legacy화 | ✅ |
| **8** 사이드바 운영 콘솔 강화 | ✅ |

## 사용 시나리오

### 시나리오 A — host 프로젝트에 `.github/` 폴더가 있음

```
my-project/
├── .github/              ← harness (이 repo)
│   ├── hooks/
│   ├── agents/
│   └── vscode-extension/
├── src/
└── ...
```

`my-project/`를 워크스페이스로 열면 `.github/`가 자동 발견된다. 설정 필요 없음.

### 시나리오 B — `.github` repo를 standalone clone

```
~/dev/.github/           ← clone한 harness
├── hooks/
├── agents/
└── vscode-extension/
```

두 가지 사용법:

**B-1. clone한 폴더 자체를 워크스페이스로**
- VS Code에서 `~/dev/.github` 열기
- 자동 발견 (워크스페이스 폴더 basename === `.github` 이면 그 자체가 harness)

**B-2. 다른 프로젝트를 열되, clone한 harness를 가리키기 (멀티 프로젝트)**
- File → Preferences → Settings → `maestro chat` 검색
- `Maestro Chat: Harness Path`에 절대 경로 입력 (예: `C:\Users\dlxog\dev\.github`)
- 어떤 프로젝트를 열어도 `@maestro`가 그 harness를 사용

> ⚠️ harness 폴더의 마지막 이름은 반드시 `.github` 여야 한다 (라우터가 `cwd/.github/...` 구조 가정).

## 개발 (F5 디버그)

### 한 번만
```powershell
cd <harness>\vscode-extension
npm install
```

### 매번
1. VS Code에서 `<harness>/vscode-extension/` 폴더 열기
2. `F5` (또는 좌측 Run and Debug → "Run Extension")
3. 자동: `npm run compile` 실행 → 두 번째 VS Code 창(Extension Development Host) 뜸
4. 두 번째 창에서 Copilot Chat 열고 `@maestro 안녕`

### Watch 모드 (코드 자주 고칠 때)
- "Run Extension (watch mode)" 디버그 구성 선택 후 F5
- `npm run watch`가 백그라운드로 돌면서 ts 저장 시 자동 컴파일
- 코드 수정 후 Extension Host 창에서 `Ctrl+R` (Reload Window) → 새 코드 반영

### 디버깅 출력

| 보고 싶은 것 | 어디 |
|---|---|
| `console.log()` 출력 | Extension Host 창 → Help → Toggle Developer Tools → Console |
| Breakpoint hit, 변수 검사 | 원본 창 → 좌측 Run and Debug 사이드바 |
| Extension activation 에러 | Extension Host → Developer Tools Console |
| Router stdout/stderr | `maestroChat.debug` 설정 켜면 채팅 응답에 표시. 또는 router-bridge에 임시 `console.log()` 추가 |
| 발견된 harness 경로 | `maestroChat.debug = true` 켜면 응답 첫 줄에 표시 |
| router/model/pipeline 이벤트 | Output 패널 → `Maestro Chat` 채널 또는 명령 `Maestro: Show Output Log` |

## 설정 (settings.json)

```jsonc
{
  // 자동 발견 실패 시 명시. 비워두면 워크스페이스에서 자동 발견.
  "maestroChat.harnessPath": "C:\\Users\\dlxog\\dev\\.github",

  // legacy router child_process 타임아웃 (ms). 기본 15000.
  "maestroChat.routerTimeoutMs": 15000,

  // 기본 false. true일 때만 hooks/scripts/maestro-router.js를 child_process로 호출.
  "maestroChat.useLegacyRouter": false,

  // 기본 true. GITHUB_PAT가 있으면 extension 내부에서 GitHub Models LLM router를 먼저 사용.
  // 실패하거나 PAT가 없으면 extension TS router로 폴백.
  "maestroChat.useLlmRouter": true,

  // 디버깅용: harness 경로, model 이름, userMessage head 등을 응답에 표시.
  "maestroChat.debug": false,

  // 기본: 같은 LLM messages 세션 안에서 extension이 파이프라인 step 순서를 직접 실행.
  "maestroChat.executorMode": "single-session",   // 또는 "multi-agent", "passthrough"

  // 선택 모델 family. 비워두면 Chat UI에서 현재 선택한 모델을 그대로 사용.
  "maestroChat.modelFamily": "",

  // single-session/multi-agent 출력/비용 제어.
  "maestroChat.streamAgentOutputs": true,
  "maestroChat.maxPriorStepChars": 4000,
  "maestroChat.maxLoggedStepChars": 4000,

  // 기존 github-state MCP를 병행 중이면 UI에 legacy 상태로 표시.
  "maestroChat.legacyMcpEnabled": false
}
```

## vsix 패키지 배포

```powershell
npm install -g @vscode/vsce
cd <harness>\vscode-extension
npm run compile
npm run package    # → maestro-chat-0.0.x.vsix
```

설치: VS Code → `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → 생성된 vsix 선택.

## 동작 흐름

```
사용자: "@maestro Next.js 14 미들웨어가 뭐야?"
   ↓
[Extension handler]
   ↓
findHarness() — setting → workspace/.github → workspace itself
   ↓
Extension TS router classifyPrompt()
  - useLlmRouter=true + GITHUB_PAT 설정 시 GitHub Models gpt-4o-mini 분류 먼저 시도
  - 실패/PAT 없음/짧은 로컬 응답은 deterministic TS router 사용
  - meta/pipelines.json 로드
  - implement/fix Tester 보정
  - Context7 prepend
  - current-todos/precompact/actionItems 주입
   ↓
buildBadge() → "🎯 작업 유형: question\n📋 파이프라인: ..."
   ↓
stream.markdown('```\n' + badge + '\n```\n\n')   ← ★ UI에 직접 (LLM 우회)
   ↓
vscode.lm.selectChatModels({ vendor: 'copilot' })[0]
   ↓
executeSingleSessionPipeline()   // executorMode=single-session 기본값
  - 같은 messages 배열 유지
  - 각 step에서 agent .agent.md 로드
  - guarded local tools 전달
  - Tester FAIL 시 Implementer → Tester retry
  - Release 전 test evidence gate
  - pipeline/flow/retro/actionItems 기록
```

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| "Maestro harness(.github 폴더)를 찾을 수 없습니다" | 위 "사용 시나리오" 중 하나 적용. 가장 빠른 해결: 설정에 `maestroChat.harnessPath` 입력 |
| "마지막 폴더명이 .github가 아닙니다" | harness 폴더 이름을 `.github`로 변경 (예: `dotgithub-harness/` → `.github/`) |
| "maestro-router.js를 찾을 수 없음" | `maestroChat.useLegacyRouter=true`일 때만 해당. 기본 TS router 사용 시 필요 없음 |
| "Language Model 선택 실패" | GitHub Copilot 확장 설치 + 로그인 확인 |
| 배지가 안 보임 | `maestroChat.debug = true` 켜고 Output → `Maestro Chat` 확인 |
| `GITHUB_PAT`를 넣었는데 `Extension TS router`로 보임 | `useLlmRouter=false`, GitHub Models 실패/timeout, PAT scope 부족, 또는 짧은 로컬 응답일 수 있음. 정상 성공 시 `GitHub Models LLM router`로 표시됨 |
| legacy hook router를 쓰고 싶음 | `maestroChat.useLegacyRouter=true`. 이 경우에만 `hooks/scripts/maestro-router.js` 경로가 사용됨 |
| 분류가 기대와 다름 | 기본은 GitHub Models LLM router → extension TS fallback. legacy hook router 비교가 필요하면 `maestroChat.useLegacyRouter=true` |
| F5 눌렀는데 Extension Host가 안 뜸 | `.vscode/launch.json` 있는지 확인. 또는 `Run and Debug → Run Extension` 선택 후 ▶ |

## UI 구성 (Phase 8)

### 사이드 패널 (Activity Bar → 🎼 Maestro)
- **GITHUB_PAT 상태**: 설정 여부 표시. 클릭하면 SetPAT 명령 실행
- **런타임 연결 상태**: Chat UI 선택 모델, Maestro 실제 사용 모델, executor mode, intent/pipeline, VS Code GitHub 인증 세션 표시
- **마이그레이션 상태**: Router가 extension TS인지 legacy hook인지, MCP가 optional인지 표시
- **MCP github-state**: 등록 여부, 현재 harness target, 도구 목록, 공유 상태 파일 표시
- **Agent Catalog**: `.agent.md`의 `tools`, `agents`, `model`, `user-invocable` 메타데이터 표시
- **현재 세션**: sessionId, 시작 시각, 진행 중인 에이전트(스피너), 최근 완료된 에이전트(소요시간/상태)
- **Subagent 호출 흐름**: 최근 세션의 Start/Stop 이벤트, source, duration, 에러 tooltip 표시
- **Test Gate**: requiredSince, 마지막 PASS/FAIL evidence, 테스트 실행 버튼
- **Todo 상태**: `current-todos.json` 진행률
- **최근 Tool Calls**: read/write/run_terminal 최근 10건
- **미해결 개선 항목**: `retrospective-draft.json`의 actionItems
- **최근 회고**: `retro.jsonl`의 마지막 5건 (제목/날짜/타입, hover 시 자기비평)

> 자동 새로고침: 런타임 상태 변경, GitHub auth session 변경, `subagent-flow.jsonl`, `pipeline.jsonl`, `test-gate-state.json`, `test-evidence.json`, `current-todos.json`, `precompact-state.json`, `retrospective-draft.json`, `retro.jsonl` 변경 시 refresh. 수동: 사이드바 우측 상단 🔄.

### MCP 상태 뷰
Activity Bar의 Maestro 컨테이너에는 별도 **MCP 상태** 뷰가 있다.

- `github-state`가 VS Code `mcp.json`에 등록됐는지 표시
- `mcp-server/dist/index.js` 빌드 여부 표시
- 등록된 MCP args가 현재 harness를 가리키는지 표시
- 19개 MCP tool surface 표시 (`todo_*`, `pipeline_*`, `actionitems_*`, `testgate_*`, `retro_*`)
- extension과 MCP가 공유하는 `logs/*` 상태 파일 존재 여부 표시

### 상태바
- `🎼 Maestro [PAT ✅]` 또는 `🎼 Maestro [PAT ⚠️]` (warning 배경) 또는 `[harness ?]`
- 클릭 → `Maestro: Set GITHUB_PAT` 명령

### 명령 팔레트 (`Ctrl+Shift+P`)
| 명령 | 동작 |
|---|---|
| Maestro: Set GITHUB_PAT | password InputBox → `.env`에 기록 |
| Maestro: Clear GITHUB_PAT | 확인 후 GITHUB_PAT 라인만 제거 (다른 키 보존) |
| Maestro: Open .env File | `.env` 파일 에디터로 열기 (없으면 생성) |
| Maestro: Open Harness Folder | 탐색기에서 harness 노출 |
| Maestro: Open Logs Folder | `logs/` 노출 |
| Maestro: Refresh Sidebar | 수동 새로고침 |
| Maestro: Show Output Log | `Output: Maestro Chat` 채널 열기 |
| Maestro: Run Extension Tests | `vscode-extension/npm test` 실행 후 test evidence 기록 |
| Maestro: Clear Action Items | actionItems 초기화 |
| Maestro: Open MCP Config | VS Code `mcp.json` 열기/생성 |

### vscode.lm 도구 (Phase 3.5 실행 연결)
| 도구 | 가드 |
|---|---|
| `maestro_read_file` | workspace 외부 deny |
| `maestro_write_file` | `.env`/키 파일 deny, `.github/{hooks,agents,...}` ask, `maestro.agent.md` ask |
| `maestro_run_terminal` | `meta/guards.json` destructiveCommands 매칭 시 deny, 안전 명령은 extension host에서 실행 |

single-session/multi-agent 모드에서는 각 에이전트 LLM 호출에 위 도구가 전달된다. 파일 쓰기 성공 시 `logs/test-gate-state.json`이 stale 처리되고, 테스트 명령 실행 시 `logs/test-evidence.json`에 PASS/FAIL 증거가 기록된다.

## 실행 모드

### single-session (기본)
파이프라인 각 step을 extension이 순서대로 실행하되 **같은 messages 배열**을 계속 유지:
- step마다 `.github/agents/{agent}.agent.md` 본문을 현재 역할 지시로 주입
- `.agent.md` frontmatter의 `agents: [...]`가 있으면 제한적 `maestro_invoke_agent` 위임 도구를 제공
- 이전 step의 assistant/tool 결과가 같은 세션 문맥에 남아 다음 step이 바로 참조
- `logs/subagent-flow.jsonl`, `logs/pipeline.jsonl` 자동 기록
- Tester FAIL 또는 stale evidence 감지 시 같은 세션 안에서 `Implementer → Tester` 재시도
- 파일 변경 후 유효한 PASS evidence가 없으면 Release 단계 차단
- 실행 종료 시 회고와 actionItems 기록

기존 문제였던 “LLM이 `maestro_invoke_agent`를 알아서 순서대로 호출해야 하는 구조”가 아니라, extension이 파이프라인을 운전한다. 그래서 싱글세션 문맥은 유지하면서도 단계 누락/순서 이탈 위험을 줄인다.

OMG와의 차이: OMG는 Copilot agent mode의 `.agent.md`/`agents: [...]` 네이티브 위임을 중심으로 동작한다. Maestro extension은 extension-controlled pipeline을 기본으로 두고, `.agent.md` 메타데이터를 읽어 UI와 제한적 read-only subagent 위임에 반영한다.

### multi-agent
파이프라인 각 step마다 **별도 vscode.lm 호출**:
- system: `.github/agents/{agent}.agent.md` 본문
- user: Maestro 컨텍스트 + 이전 step 출력 + 원본 요청
- 각 step의 출력은 `### ⚙️ [N/M] {Agent} 실행 중…` 헤더와 함께 스트리밍
- `logs/subagent-flow.jsonl`, `logs/pipeline.jsonl` 자동 기록 (기존 분석 도구 호환)
- Tester FAIL 또는 stale evidence 감지 시 `Implementer → Tester`를 `meta/pipelines.json.maxTesterRetries`만큼 재시도
- 파일 변경 후 유효한 PASS evidence가 없으면 Release 단계 차단
- 실행 종료 시 `logs/retrospective-draft.json`과 `logs/retro.jsonl`에 extension 실행 회고를 기록
- 누락된 필수 에이전트(Tester/Critic 등)는 actionItems로 남겨 다음 실행에서 다시 주입

토큰 더 소비, 시간 더 걸리지만 step마다 독립된 호출로 격리된다. single-session보다 문맥 공유는 약하지만 역할 분리는 더 강하다.

### passthrough (비추천 / 디버그용)
분류 → 배지 출력 → Maestro userMessage 전체를 **단일 LLM 호출**. 빠르지만 LLM이 multi-agent 흐름을 스스로 모방해야 해서 파이프라인 이탈 가능성이 있다.

### Deterministic Local Routes
일부 workspace inspection 요청은 LLM/라우터를 거치지 않고 extension이 직접 처리한다.

| 요청 예 | 실행 |
|---|---|
| `변경 들어온게 뭐지?`, `git diff 보여줘`, `status` | `Git Inspector → Release`: `git status --short`, `git diff --stat`, `git diff --cached --stat`, 최근 커밋 5개를 직접 조회 |

`settings.json`에서 `maestroChat.executorMode` 전환.

## 알려진 한계 (Phase 8)

- 병렬 실행 없음
- vscode.lm으로 받는 모델은 Copilot 설정 따름
- 사이드바 watcher는 Node fs.watch 기반 (workspace 외부 harness도 감시 가능하지만 일부 환경에서 이벤트 누락 가능 → 수동 refresh로 보완)
- legacy hook/MCP 코드는 호환용으로 남아있지만 extension 기본 경로에서는 필요하지 않음

## 테스트 / CI

로컬:

```powershell
cd <harness>\vscode-extension
npm test
```

검증 범위:
- `.env` 편집 유틸이 기존 라인/주석을 보존하는지
- standalone `.github` clone 경로 계산
- Maestro 배지 추출
- `.agent.md` 로더의 CRLF/frontmatter/Context7 fallback 매칭
- `meta/guards.json` 기반 shell/file guard 판정
- extension TS router pipeline normalization
- hook classifier core intent/pipeline parity matrix
- saved todo/precompact/actionItems 주입
- test-gate + retrospective/actionItems 회귀
- MCP view/command/tool surface 회귀

CI:
- `.github/workflows/vscode-extension-ci.yml`
- Windows + Node 22
- `npm ci` → `npm test`

## 다음 단계

- Phase 9: legacy hooks 비활성화/아카이브 스위치 정리
- Phase 10: VSIX 패키징, 설치 온보딩, 릴리즈 노트 자동화
