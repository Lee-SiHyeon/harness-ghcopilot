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
| 3.5 executor에서 tool calling 활용 (Implementer가 실제 파일 수정) | ❌ |
| 4 Tester FAIL → Implementer 재시도 루프, 회고 자동 트리거 | ❌ |
| 5 기존 hook 비활성화 | ❌ |

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

  // 라우터 child_process 타임아웃 (ms). 기본 15000.
  "maestroChat.routerTimeoutMs": 15000,

  // 디버깅용: harness 경로, model 이름, userMessage head 등을 응답에 표시.
  "maestroChat.debug": false,

  // Phase 1 동작 (단일 LLM 호출, 빠름) vs Phase 2 동작 (파이프라인 step마다 호출, 진짜 멀티 에이전트)
  "maestroChat.executorMode": "multi-agent",   // 또는 "passthrough"

  // 선택 모델 family. 비워두면 첫 번째 Copilot 모델 사용.
  "maestroChat.modelFamily": "",

  // multi-agent 출력/비용 제어.
  "maestroChat.streamAgentOutputs": true,
  "maestroChat.maxPriorStepChars": 4000,
  "maestroChat.maxLoggedStepChars": 4000
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
spawn node <harness>/hooks/scripts/maestro-router.js
  cwd: parent of harness   (router uses cwd/.github/... internally)
  env: USER_PROMPT=..., AGENT_NAME="Maestro"
   ↓
stdout JSON parse → { modifiedParameters: { userMessage: "..." } }
   ↓
extractBadge(userMessage) → "🎯 작업 유형: question\n📋 파이프라인: ..."
   ↓
stream.markdown('```\n' + badge + '\n```\n\n')   ← ★ UI에 직접 (LLM 우회)
   ↓
vscode.lm.selectChatModels({ vendor: 'copilot' })[0]
   ↓
model.sendRequest([User(userMessage)], {}, token)
   ↓
for await (fragment) stream.markdown(fragment)
```

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| "Maestro harness(.github 폴더)를 찾을 수 없습니다" | 위 "사용 시나리오" 중 하나 적용. 가장 빠른 해결: 설정에 `maestroChat.harnessPath` 입력 |
| "마지막 폴더명이 .github가 아닙니다" | harness 폴더 이름을 `.github`로 변경 (예: `dotgithub-harness/` → `.github/`) |
| "maestro-router.js를 찾을 수 없음" | harnessPath/`hooks/scripts/maestro-router.js` 경로 확인. clone이 얕은 git에 빠진 파일 없는지 |
| "Language Model 선택 실패" | GitHub Copilot 확장 설치 + 로그인 확인 |
| 배지가 안 보임 | `maestroChat.debug = true` 켜고 router output 확인. AGENT_NAME=Maestro로 호출되면 isMaestroContext 분기 발동해야 함 |
| 매번 regex 폴백으로 분류 | `.env`에 `GITHUB_PAT=ghp_...` 설정하면 gpt-4o-mini 사용. `.env`는 harness 폴더의 부모(cwd)에 둬야 함 |
| F5 눌렀는데 Extension Host가 안 뜸 | `.vscode/launch.json` 있는지 확인. 또는 `Run and Debug → Run Extension` 선택 후 ▶ |

## UI 구성 (Phase 3)

### 사이드 패널 (Activity Bar → 🎼 Maestro)
- **GITHUB_PAT 상태**: 설정 여부 표시. 클릭하면 SetPAT 명령 실행
- **현재 세션**: sessionId, 시작 시각, 진행 중인 에이전트(스피너), 최근 완료된 에이전트(소요시간/상태)
- **미해결 개선 항목**: `retrospective-draft.json`의 actionItems
- **최근 회고**: `retro.jsonl`의 마지막 5건 (제목/날짜/타입, hover 시 자기비평)

> 자동 새로고침: `logs/subagent-flow.jsonl`, `retrospective-draft.json`, `retro.jsonl` 변경 시 debounce 500ms 후 refresh. 수동: 사이드바 우측 상단 🔄.

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

### vscode.lm 도구 (Phase 3 스캐폴딩)
| 도구 | 가드 |
|---|---|
| `maestro_read_file` | workspace 외부 deny |
| `maestro_write_file` | `.env`/키 파일 deny, `.github/{hooks,agents,...}` ask, `maestro.agent.md` ask |
| `maestro_run_terminal` | `meta/guards.json` destructiveCommands 매칭 시 ask + 자동 실행 X (사용자가 Enter) |

> ⚠️ Phase 3에서는 도구가 **등록만** 되어 있고 executor는 아직 사용하지 않는다. Phase 3.5에서 executor가 Implementer를 부를 때 `requestOptions.tools`로 전달 예정.

## 실행 모드

### multi-agent (기본)
파이프라인 각 step마다 **별도 vscode.lm 호출**:
- system: `.github/agents/{agent}.agent.md` 본문
- user: Maestro 컨텍스트 + 이전 step 출력 + 원본 요청
- 각 step의 출력은 `### ⚙️ [N/M] {Agent} 실행 중…` 헤더와 함께 스트리밍
- `logs/subagent-flow.jsonl`, `logs/pipeline.jsonl` 자동 기록 (기존 분석 도구 호환)

토큰 더 소비, 시간 더 걸리지만 extension이 파이프라인 step을 실제로 순차 실행한다.

### passthrough (비추천 / 디버그용)
분류 → 배지 출력 → Maestro userMessage 전체를 **단일 LLM 호출**. 빠르지만 LLM이 multi-agent 흐름을 스스로 모방해야 해서 파이프라인 이탈 가능성이 있다.

### Deterministic Local Routes
일부 workspace inspection 요청은 LLM/라우터를 거치지 않고 extension이 직접 처리한다.

| 요청 예 | 실행 |
|---|---|
| `변경 들어온게 뭐지?`, `git diff 보여줘`, `status` | `Git Inspector → Release`: `git status --short`, `git diff --stat`, `git diff --cached --stat`, 최근 커밋 5개를 직접 조회 |

`settings.json`에서 `maestroChat.executorMode` 전환.

## 알려진 한계 (Phase 3)

- 도구는 등록만 됨 — executor가 아직 사용하지 않음 → Phase 3.5
- `maestro_run_terminal`은 터미널에 텍스트만 입력 (자동 실행 X) — Phase 4에서 결과 캡처와 함께 도입
- Tester FAIL 시 Implementer 재호출 루프 없음 — Phase 4
- 병렬 실행 없음
- 일반 요청은 매 turn 새 프로세스로 router 호출 (~수십 ms 오버헤드). deterministic local route는 router를 건너뜀
- vscode.lm으로 받는 모델은 Copilot 설정 따름
- 사이드바 watcher는 Node fs.watch 기반 (workspace 외부 harness도 감시 가능하지만 일부 환경에서 이벤트 누락 가능 → 수동 refresh로 보완)

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

CI:
- `.github/workflows/vscode-extension-ci.yml`
- Windows + Node 22
- `npm ci` → `npm test`

## 다음 단계

`.github/REQUIREMENTS.md` 참조.
