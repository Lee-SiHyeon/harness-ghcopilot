# Maestro Chat — VS Code Extension

`.github/` 하네스를 위한 ChatParticipant `@maestro`.
훅 주입 방식(LLM이 무시 가능)의 한계를 우회해, 분류 배지를 **UI에 직접 스트리밍**한다.

## 왜 만들었나

기존 hook-based 시스템은 `modifiedParameters.userMessage`로 헤더를 주입하지만, LLM이 이를 응답에 포함할지는 확률적이다 (실제로 `📋 파이프라인: 직접 답변` 같은 H1 위반 사례 발생). VS Code Extension은 `ChatResponseStream.markdown()`으로 LLM과 무관하게 UI에 직접 쓸 수 있어 100% 보장된다.

## Phase 0 범위

| 기능 | 상태 |
|---|---|
| `@maestro` ChatParticipant 등록 | ✅ |
| `.github/hooks/scripts/maestro-router.js`를 child_process로 호출해 분류·헤더 받음 | ✅ |
| 배지를 stream.markdown()으로 **강제 출력** | ✅ |
| Maestro userMessage(헤더 + todo 가이드 + 회고 + 원본 요청)를 vscode.lm으로 LLM에 전달 | ✅ |
| LLM 응답 스트림을 채팅에 그대로 흘려보냄 | ✅ |
| HITL gate (router decision='ask') 시 사용자 확인 요청 표시 | ✅ |
| 서브에이전트 호출 (Planner/Implementer/...) | ❌ Phase 2 |
| 가드 (safety/file) 내부 이주 | ❌ Phase 3 |
| 회고 자동 트리거 | ❌ Phase 4 |
| 기존 hook 비활성화 | ❌ Phase 5 |

## 설치 — 개발(F5)

```powershell
cd C:\Users\dlxog\projects\.github\vscode-extension
npm install
npm run compile
# VS Code에서 이 폴더 열고 F5 → Extension Development Host 창 뜸
```

새 창에서:
1. Copilot Chat 패널 열기
2. `@maestro 안녕`
3. 응답 첫 줄에 `🎯 작업 유형 / 📋 파이프라인 / 🔍 분류 방식` 코드 블록이 **반드시** 보여야 한다

## 패키지(vsix) 배포

```powershell
npm install -g @vscode/vsce
cd C:\Users\dlxog\projects\.github\vscode-extension
npm run compile
npm run package   # → maestro-chat-0.0.1.vsix
```

설치: VS Code → `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

## 동작 흐름

```
사용자: "@maestro Next.js 14 미들웨어가 뭐야?"
   ↓
[ChatParticipant handler]
   ↓
spawn node .github/hooks/scripts/maestro-router.js
  env: USER_PROMPT="Next.js 14 미들웨어가 뭐야?", AGENT_NAME="Maestro"
   ↓
stdout JSON: { modifiedParameters: { userMessage: "## [⚠️ 필수...]\n```\n🎯...\n```\n..." } }
   ↓
extractBadge() → "🎯 작업 유형: question\n📋 파이프라인: Context7 Docs Agent → Critic → Release\n🔍 분류 방식: ..."
   ↓
stream.markdown('```\n' + badge + '\n```\n\n')   ← ★ UI에 직접 씀 (LLM 우회)
   ↓
vscode.lm.selectChatModels({ vendor: 'copilot' })[0]
   ↓
model.sendRequest([User(userMessage)], {}, token)
   ↓
for await (fragment of response.text) stream.markdown(fragment)
```

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| "워크스페이스가 열려있지 않습니다" | `.github/` 폴더가 있는 워크스페이스를 여세요 |
| "maestro-router 호출 실패" | `node .github/hooks/scripts/maestro-router.js` 직접 실행으로 디버그. `USER_PROMPT` 환경변수 필요 |
| "Language Model 선택 실패" | GitHub Copilot 확장 활성화 + 로그인 확인 |
| 배지가 안 보임 | router stdout이 `modifiedParameters.userMessage`를 포함하는지 확인. router 입장에서 isMaestroContext 분기가 발동해야 함 (AGENT_NAME=Maestro로 전달됨) |
| 분류가 매번 regex 폴백 | `.env`에 `GITHUB_PAT=ghp_...` 설정 (gpt-4o-mini 사용 위함) |

## 알려진 한계 (Phase 0)

- 서브에이전트는 실제로 호출하지 않는다 (배지만 표시하고 LLM이 알아서 응답 생성)
- todo 가이드 등 userMessage 내용을 LLM이 다 따를지는 여전히 확률적 (단, 배지 UI 출력은 100%)
- maestro-router를 매 turn 새 프로세스로 spawn (성능 최적화는 Phase 1+)
- vscode.lm으로 받는 모델이 Claude/GPT-4 중 무엇인지는 Copilot 설정 따름

## 다음 단계 (Phase 1+)

`.github/REQUIREMENTS.md` 9번 항목 + 본 README의 Phase 0 표 참고.
