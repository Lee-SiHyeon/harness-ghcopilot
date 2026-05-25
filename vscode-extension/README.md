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
| 3 safety/file-guard tool API 인터셉터 이주 + 도구 호출 지원 | ❌ |
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
  "maestroChat.executorMode": "passthrough"   // 또는 "multi-agent"
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

## 실행 모드

### passthrough (기본, Phase 1 동작)
분류 → 배지 출력 → Maestro userMessage 전체를 **단일 LLM 호출**. 빠르지만 LLM이 multi-agent 흐름을 스스로 모방해야 한다.

### multi-agent (Phase 2)
파이프라인 각 step마다 **별도 vscode.lm 호출**:
- system: `.github/agents/{agent}.agent.md` 본문
- user: Maestro 컨텍스트 + 이전 step 출력 + 원본 요청
- 각 step의 출력은 `### ⚙️ [N/M] {Agent} 실행 중…` 헤더와 함께 스트리밍
- `logs/subagent-flow.jsonl`, `logs/pipeline.jsonl` 자동 기록 (기존 분석 도구 호환)

토큰 더 소비, 시간 더 걸림. 진짜 multi-agent 추론이 필요할 때 사용.

`settings.json`에서 `maestroChat.executorMode` 전환.

## 알려진 한계 (Phase 2)

- multi-agent 모드에서도 **도구 호출 안 됨** — Implementer가 "이렇게 수정할 것입니다"라고 텍스트로만 답함 (실제 파일 수정 X). Phase 3에서 vscode.lm tools API로 해결.
- Tester FAIL 시 Implementer 재호출 루프 없음. Phase 4 예정.
- 병렬 실행 없음. 모든 step 순차.
- 매 turn 새 프로세스로 router 호출 (~수십 ms 오버헤드)
- vscode.lm으로 받는 모델은 Copilot 설정 따름

## 다음 단계

`.github/REQUIREMENTS.md` 참조.
