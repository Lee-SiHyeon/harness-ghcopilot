import * as vscode from 'vscode';
import { HarnessPaths } from '../state/paths';
import { loadAgent } from '../agents/loader';
import { redactSecrets } from '../state/redaction';

/**
 * maestro_invoke_agent — single-session 모드 전용 서브에이전트 호움 도구.
 *
 * outer LLM이 이 도구를 호움하면, 해당 에이전트의 .agent.md 시스템 프롬프트로
 * 별도 sendRequest() 세션을 열고, 결과를 tool result로 반환한다.
 * 재귀 방지: 서브에이전트에는 이 도구를 전달하지 않는다. 최대 중첩 깊이 2.
 */

import { AGENT_TOOL_NAME, InvokerContext, MAX_INVOKE_DEPTH, validateInvokeInput } from './agent-constants';
export { AGENT_TOOL_NAME, MAX_INVOKE_DEPTH } from './agent-constants';

const contexts = new Map<string, InvokerContext>();

/** extension이 single-session 시작 전 context_id별로 주입하고 종료 후 정리한다. */
export function setActiveInvokerContext(
  id: string,
  model: vscode.LanguageModelChat | null,
  paths: HarnessPaths | null,
  toolToken?: vscode.ChatParticipantToolToken,
): void {
  if (!model || !paths) {
    contexts.delete(id);
    return;
  }
  contexts.set(id, { id, model, paths, toolToken, depth: 0 });
}

export function clearActiveInvokerContext(id: string): void {
  contexts.delete(id);
}

export function getActiveInvokerContext(id: string): InvokerContext {
  return contexts.get(id) ?? { id, model: null, paths: null, toolToken: undefined, depth: 0 };
}

export interface InvokeAgentInput {
  /** single-session 요청마다 extension이 발급한 컨텍스트 ID */
  context_id: string;
  /** agents/ 폴더에서 로드할 에이전트 이름. 예: "Planner", "Reviewer" */
  agent_name: string;
  /** 이 에이전트에게 맡길 구체적인 작업 지시 */
  task: string;
  /** 이전 단계 결과 등 추가 콘텍스트 (선택) */
  prior_context?: string;
}

/**
 * 에이전트를 호움하고 결과 텍스트를 반환한다.
 * vscode.lm.registerTool invoke 핸들러에서 호움한다.
 */
export async function invokeAgent(
  input: InvokeAgentInput,
  token: vscode.CancellationToken,
  ctx: InvokerContext,
): Promise<string> {
  const validationError = validateInvokeInput(ctx, input);
  if (validationError) return validationError;
  const agent = loadAgent(ctx.paths as HarnessPaths, input.agent_name);
  if (!agent) {
    return `⚠️ maestro_invoke_agent: "${input.agent_name}" 에이전트를 찾지 못했습니다. agents/ 폴더에 .agent.md가 있는지 확인하세요.`;
  }

  ctx.depth++;
  try {
    // 서브에이전트 메시지 구성
    const contextBlock = input.prior_context
      ? `## [이전 콘텍스트]
${input.prior_context}

`
      : '';
    const userContent = `${contextBlock}## [임무]
${input.task}`;

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(agent.systemPrompt),
      vscode.LanguageModelChatMessage.User(userContent),
    ];

    // 서브에이전트에는 read-only 도구만, invoke_agent 자신은 전달하지 않음
    const subTools = vscode.lm.tools.filter(t =>
      ['maestro_read_file', 'maestro_list_files', 'maestro_search_files'].includes(t.name),
    );

    let output = '';
    const maxRounds = subTools.length > 0 ? 3 : 1;
    let endedAfterToolCalls = false;

    for (let round = 0; round < maxRounds; round++) {
      if (token.isCancellationRequested) break;
      endedAfterToolCalls = false;

      const response = await (ctx.model as vscode.LanguageModelChat).sendRequest(messages, {
        tools: subTools,
        toolMode: subTools.length > 0 ? vscode.LanguageModelChatToolMode.Auto : undefined,
        justification: `Maestro invoke_agent: ${input.agent_name} (depth ${ctx.depth})`,
      }, token);

      const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];

      for await (const part of response.stream) {
        if (token.isCancellationRequested) break;
        if (part instanceof vscode.LanguageModelTextPart) {
          assistantParts.push(part);
          output += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          assistantParts.push(part);
          toolCalls.push(part);
        }
      }

      if (toolCalls.length === 0) break;
      endedAfterToolCalls = true;

      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
      for (const call of toolCalls) {
        const result = await vscode.lm.invokeTool(call.name, {
          input: call.input,
          toolInvocationToken: ctx.toolToken as vscode.ChatParticipantToolToken | undefined,
        }, token);
        messages.push(vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(call.callId, result.content),
        ]));
      }
    }
    if (output.trim().length === 0 && endedAfterToolCalls) {
      messages.push(vscode.LanguageModelChatMessage.User(
        '도구 호출은 끝났다. 추가 도구 호출 없이, 지금까지의 도구 결과만 바탕으로 subagent 최종 답변을 작성하라.',
      ));
      const response = await (ctx.model as vscode.LanguageModelChat).sendRequest(messages, {
        tools: [],
        justification: `Maestro invoke_agent final answer: ${input.agent_name}`,
      }, token);
      for await (const part of response.stream) {
        if (token.isCancellationRequested) break;
        if (part instanceof vscode.LanguageModelTextPart) output += part.value;
      }
    }

    const cleaned = redactSecrets(output.trim());
    return cleaned || `(${input.agent_name} 결과 없음)`;
  } finally {
    ctx.depth--;
  }
}
