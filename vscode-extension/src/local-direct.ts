export function renderLocalDirectAnswer(prompt: string, intent: string, pipeline: string[]): string | undefined {
  if (pipeline.length > 0) return undefined;
  if (intent !== 'query' && intent !== 'question') return undefined;

  const text = prompt.trim();
  const compact = text.toLowerCase();
  if (!compact) return undefined;

  if (isCasualStatus(compact)) {
    return [
      '대기 중입니다. 지금은 Maestro 확장 안에서 요청을 분류하고, 필요하면 파이프라인을 extension이 직접 실행하도록 준비되어 있어요.',
      '',
      '이런 짧은 상태/인사성 요청은 Copilot 크레딧을 쓰지 않도록 로컬에서 바로 답합니다. 작업을 맡기려면 예를 들어 `이 확장 문제점 고쳐줘`, `테스트 돌리고 커밋해줘`, `변경 들어온 게 뭐지?`처럼 말하면 됩니다.',
    ].join('\n');
  }

  if (isHelpRequest(compact)) {
    return [
      'Maestro는 Copilot Chat participant로 동작하면서 요청을 분류하고, 필요하면 `Planner -> Implementer -> Tester -> Reviewer -> Critic -> Release` 같은 파이프라인을 실행합니다.',
      '',
      '- 짧은 질문/상태 확인: 로컬 또는 직접 답변',
      '- 코드 조사: Inspector/Reviewer 계열',
      '- 수정 요청: Implementer 이후 Tester/Reviewer/Critic/Release',
      '- 변경 확인: git 상태/diff 로컬 조회',
      '',
      '현재 기본 모드는 `single-session`이며, 같은 messages 세션을 유지하되 extension이 step 순서를 직접 운전합니다.',
    ].join('\n');
  }

  return undefined;
}

function isCasualStatus(text: string): boolean {
  return text.length <= 24 && /^(야\s*)?(뭐해|뭐하냐|뭐함|안녕|ㅎㅇ|하이|hi|hello|hey)\??!?$/i.test(text);
}

function isHelpRequest(text: string): boolean {
  return text.length <= 40 && /(사용법|도움말|help|뭐 할 수|뭐할 수|이 확장 뭐|마에스트로 뭐|maestro 뭐)/i.test(text);
}
