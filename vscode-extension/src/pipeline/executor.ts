import * as vscode from 'vscode';
import { AgentDefinition, loadAgent } from '../agents/loader';
import { HarnessPaths } from '../state/paths';
import { appendFlow, newCorrelationId } from '../state/subagent-flow';
import { appendPipelineStep } from '../state/pipeline-log';
import { MAESTRO_TOOL_NAMES } from '../tools/registry';

export interface ExecutorContext {
  paths: HarnessPaths;
  pipelineId?: string;
  sessionId: string;
  userTask: string;
  /** Maestro 헤더 + 회고 + actionItems 등 분류기 결과 전체. */
  maestroContext: string;
  stream: vscode.ChatResponseStream;
  cancellation: vscode.CancellationToken;
  model: vscode.LanguageModelChat;
  debug?: boolean;
  streamAgentOutputs?: boolean;
  maxPriorOutputChars?: number;
  maxLoggedOutputChars?: number;
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  enableTools?: boolean;
  logger?: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
}

export interface StepResult {
  agentName: string;
  output: string;
  correlationId: string;
  durationMs: number;
  skipped?: boolean;
  errorMessage?: string;
}

/**
 * 파이프라인 단계를 순차로 실행한다. 각 단계는 별개 vscode.lm.sendRequest.
 *
 * 메시지 구성:
 *   - system: agent의 .agent.md 본문
 *   - user: Maestro context + 누적된 이전 단계 출력 + 원본 요청
 *
 * Phase 2 제한:
 *   - 도구 호출 없음 (Phase 3에서 vscode.lm tools)
 *   - 재시도 루프 없음 (Phase 4에서 Tester FAIL → Implementer)
 *   - 병렬 호출 없음 (필요 시 Phase 3+)
 */
export async function executePipeline(
  steps: string[],
  ctx: ExecutorContext,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  if (steps.length === 0) {
    ctx.stream.markdown('\n⚠️ 실행할 파이프라인 단계가 없습니다.\n');
    return results;
  }

  for (let i = 0; i < steps.length; i++) {
    if (ctx.cancellation.isCancellationRequested) break;
    const agentName = steps[i];
    const stepNumber = i + 1;

    const correlationId = newCorrelationId();
    const startTs = new Date().toISOString();
    appendFlow(ctx.paths, {
      event: 'SubagentStart',
      agentName,
      sessionId: ctx.sessionId,
      correlationId,
      source: 'extension-executor',
    });
    ctx.logger?.info('agent start', { agentName, stepNumber, total: steps.length, correlationId });

    ctx.stream.markdown(
      `\n\n---\n\n### ⚙️ [${stepNumber}/${steps.length}] ${agentName} 실행 중…\n\n`,
    );

    const agent = loadAgent(ctx.paths, agentName);
    const t0 = Date.now();

    if (!agent) {
      const msg = `(스킵: \`agents/${agentName}.agent.md\`를 찾지 못해 이 단계를 건너뜁니다.)`;
      ctx.stream.markdown(msg);
      const durationMs = Date.now() - t0;
      appendFlow(ctx.paths, {
        event: 'SubagentStop',
        agentName,
        sessionId: ctx.sessionId,
        correlationId,
        startTs,
        stopTs: new Date().toISOString(),
        durationMs,
        source: 'extension-executor',
        skipped: true,
      });
      results.push({ agentName, output: '', correlationId, durationMs, skipped: true });
      ctx.logger?.warn('agent skipped: definition not found', { agentName, durationMs });
      continue;
    }

    if (ctx.debug) {
      ctx.stream.markdown(`> [debug] system prompt ${agent.systemPrompt.length} chars\n\n`);
    }

    const userMessage = buildUserMessage(ctx, agent, results);
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(agent.systemPrompt),
      vscode.LanguageModelChatMessage.User(userMessage),
    ];

    let output = '';
    let errorMessage: string | undefined;
    try {
      output = await runAgentModelLoop(ctx, messages);
      if (ctx.streamAgentOutputs === false) {
        ctx.stream.markdown(`_(출력 ${output.length} chars 생성됨 — 로그에 기록)_\n`);
      }
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      ctx.stream.markdown(`\n\n⚠️ ${agentName} 실행 실패: ${errorMessage}\n`);
      ctx.logger?.error('agent failed', { agentName, errorMessage });
    }

    const durationMs = Date.now() - t0;
    appendFlow(ctx.paths, {
      event: 'SubagentStop',
      agentName,
      sessionId: ctx.sessionId,
      correlationId,
      startTs,
      stopTs: new Date().toISOString(),
      durationMs,
      source: 'extension-executor',
      ...(errorMessage ? { error: errorMessage } : {}),
    });
    appendPipelineStep(ctx.paths, {
      pipeline_id: ctx.pipelineId,
      step: agentName,
      output: output.slice(0, ctx.maxLoggedOutputChars ?? 4000),
      extra: { durationMs, correlationId, ...(errorMessage ? { error: errorMessage } : {}) },
    });

    results.push({ agentName, output, correlationId, durationMs, errorMessage });
    ctx.logger?.info('agent stop', {
      agentName,
      durationMs,
      chars: output.length,
      correlationId,
      error: errorMessage,
    });

    // Maestro 정책: Reviewer 가 critical 발견 또는 Tester FAIL은 Phase 4에서
    // 재시도 루프로 처리. Phase 2에서는 발견만 표시.
    if (errorMessage) {
      ctx.stream.markdown(`\n> ⚠️ ${agentName} 단계 오류로 다음 단계를 그대로 진행합니다 (Phase 4에서 재시도 루프 추가 예정).\n`);
    }
  }

  ctx.stream.markdown(`\n\n---\n\n✅ 파이프라인 완료 (${results.length}개 단계).\n`);
  return results;
}

async function runAgentModelLoop(
  ctx: ExecutorContext,
  messages: vscode.LanguageModelChatMessage[],
): Promise<string> {
  const tools = ctx.enableTools === false
    ? []
    : vscode.lm.tools.filter(t => MAESTRO_TOOL_NAMES.includes(t.name));
  let output = '';
  const maxRounds = tools.length > 0 ? 4 : 1;

  for (let round = 0; round < maxRounds; round++) {
    const response = await ctx.model.sendRequest(messages, {
      tools,
      toolMode: tools.length > 0 ? vscode.LanguageModelChatToolMode.Auto : undefined,
      justification: 'Maestro extension pipeline execution with guarded local tools.',
    }, ctx.cancellation);

    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const part of response.stream) {
      if (ctx.cancellation.isCancellationRequested) break;
      if (part instanceof vscode.LanguageModelTextPart) {
        assistantParts.push(part);
        output += part.value;
        if (ctx.streamAgentOutputs !== false) {
          ctx.stream.markdown(part.value);
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        assistantParts.push(part);
        toolCalls.push(part);
        ctx.logger?.info('tool call requested', { name: part.name, input: part.input });
      }
    }

    if (toolCalls.length === 0) break;
    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    for (const call of toolCalls) {
      const result = await vscode.lm.invokeTool(call.name, {
        input: call.input,
        toolInvocationToken: ctx.toolInvocationToken,
      }, ctx.cancellation);
      messages.push(vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(call.callId, result.content),
      ]));
      ctx.logger?.info('tool call completed', { name: call.name, callId: call.callId });
    }
  }

  return output;
}

function buildUserMessage(
  ctx: ExecutorContext,
  agent: AgentDefinition,
  priorResults: StepResult[],
): string {
  const parts: string[] = [];

  // Maestro 컨텍스트 (헤더, 회고, actionItems 등)
  if (ctx.maestroContext.trim()) {
    parts.push('## [Maestro 컨텍스트]');
    parts.push(ctx.maestroContext);
  }

  // 이전 단계 결과
  if (priorResults.length > 0) {
    parts.push('## [이전 단계 결과]');
    for (const prior of priorResults) {
      if (prior.skipped) {
        parts.push(`### ${prior.agentName}\n(스킵됨)`);
        continue;
      }
      const maxChars = ctx.maxPriorOutputChars ?? 4000;
      const snippet = prior.output.length > maxChars
        ? prior.output.slice(0, maxChars) + '\n...(생략)'
        : prior.output;
      parts.push(`### ${prior.agentName}\n${snippet || '(빈 출력)'}`);
    }
  }

  // 원본 요청 + 이번 에이전트가 해야 할 일
  parts.push('## [원본 요청]');
  parts.push(ctx.userTask);
  parts.push('## [이번 단계 임무]');
  parts.push(
    `당신은 **${agent.name}** 입니다. 위 시스템 프롬프트의 역할 정의에 따라, ` +
    `Maestro 컨텍스트와 이전 단계 결과를 검토한 뒤 이번 단계의 결과물을 ` +
    `사용자에게 곧바로 출력하세요. 배지/파이프라인 헤더는 이미 extension UI가 출력했으므로 ` +
    `절대 반복하지 마세요. 다른 에이전트 호출이나 도구 호출은 이 Phase에서는 지원되지 않으므로 텍스트로만 응답하세요.`,
  );

  return parts.join('\n\n');
}
