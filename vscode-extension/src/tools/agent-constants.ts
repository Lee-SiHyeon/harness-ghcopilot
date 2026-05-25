/** agent-tool 관련 상수 및 순수 검증 함수 — vscode 없이 require 가능 (테스트용). */
export const AGENT_TOOL_NAME = 'maestro_invoke_agent';
export const MAX_INVOKE_DEPTH = 2;

export interface InvokeAgentInputRaw {
  agent_name?: unknown;
  task?: unknown;
  prior_context?: unknown;
}

export interface InvokerContext {
  model: unknown;
  paths: unknown;
  toolToken: unknown;
  depth: number;
}

/**
 * invokeAgent 호출 사전 검증 — 순수 함수, vscode 의존성 없음.
 * 문제가 있으면 에러 메시지 문자열 반환, 없으면 null.
 */
export function validateInvokeInput(
  ctx: InvokerContext,
  input: InvokeAgentInputRaw,
): string | null {
  if (!ctx.model) return '⚠️ maestro_invoke_agent: 활성 모델 없음. single-session 모드에서만 사용 가능합니다.';
  if (!ctx.paths) return '⚠️ maestro_invoke_agent: harness paths가 없습니다.';
  if (ctx.depth >= MAX_INVOKE_DEPTH) return '⚠️ maestro_invoke_agent: 최대 중첩 깊이(' + MAX_INVOKE_DEPTH + ') 초과 — 재귀 호출 차단됨.';
  if (!input.agent_name || typeof input.agent_name !== 'string') return '⚠️ maestro_invoke_agent: agent_name이 비어 있습니다.';
  if (!input.task || typeof input.task !== 'string') return '⚠️ maestro_invoke_agent: task가 비어 있습니다.';
  return null;
}
