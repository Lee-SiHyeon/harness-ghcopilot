import * as vscode from 'vscode';
import { AgentDefinition, loadAgent } from '../agents/loader';
import { HarnessPaths } from '../state/paths';
import { appendFlow, newCorrelationId } from '../state/subagent-flow';
import { appendPipelineStep } from '../state/pipeline-log';
import { getGateState, getTestEvidence, isEvidenceValid } from '../state/test-gate';
import { MAESTRO_TOOL_NAMES } from '../tools/registry';
import { loadPipelineConfig } from './config';

export interface ExecutorContext {
  paths: HarnessPaths;
  pipelineId?: string;
  sessionId: string;
  userTask: string;
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
  attempt?: number;
  gateBlocked?: boolean;
}

export async function executePipeline(
  steps: string[],
  ctx: ExecutorContext,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  if (steps.length === 0) {
    ctx.stream.markdown('\n⚠️ 실행할 파이프라인 단계가 없습니다.\n');
    return results;
  }

  const config = loadPipelineConfig(ctx.paths);
  const maxTesterRetries = Math.max(0, config.maxTesterRetries ?? 3);
  const hasImplementer = steps.includes('Implementer');

  for (let i = 0; i < steps.length; i++) {
    if (ctx.cancellation.isCancellationRequested) break;
    const agentName = steps[i];

    if (agentName === 'Release' && shouldBlockRelease(ctx)) {
      const blocked = blockRelease(ctx, results);
      results.push(blocked);
      break;
    }

    const result = await runStep(agentName, i + 1, steps.length, ctx, results);
    results.push(result);

    if (agentName === 'Tester' && testerFailed(ctx, result) && hasImplementer) {
      for (let retry = 1; retry <= maxTesterRetries && testerFailed(ctx, result); retry++) {
        if (ctx.cancellation.isCancellationRequested) break;
        ctx.stream.markdown(
          `\n\n> 🔁 Tester 실패 감지 — Implementer 재시도 ${retry}/${maxTesterRetries} 후 Tester 재검증\n\n`,
        );
        const implRetry = await runStep('Implementer', i + 1, steps.length, ctx, results, retry);
        results.push(implRetry);
        const testerRetry = await runStep('Tester', i + 1, steps.length, ctx, results, retry);
        results.push(testerRetry);
        if (!testerFailed(ctx, testerRetry)) break;
      }
    }
  }

  ctx.stream.markdown(`\n\n---\n\n✅ 파이프라인 완료 (${results.length}개 단계 기록).\n`);
  return results;
}

async function runStep(
  agentName: string,
  stepNumber: number,
  totalSteps: number,
  ctx: ExecutorContext,
  priorResults: StepResult[],
  attempt = 0,
): Promise<StepResult> {
  const correlationId = newCorrelationId();
  const startTs = new Date().toISOString();
  appendFlow(ctx.paths, {
    event: 'SubagentStart',
    agentName,
    sessionId: ctx.sessionId,
    correlationId,
    source: 'extension-executor',
    ...(attempt ? { attempt } : {}),
  });
  ctx.logger?.info('agent start', { agentName, stepNumber, total: totalSteps, correlationId, attempt });

  ctx.stream.markdown(
    `\n\n---\n\n### ⚙️ [${stepNumber}/${totalSteps}] ${agentName}${attempt ? ` 재시도 ${attempt}` : ''} 실행 중…\n\n`,
  );

  const agent = loadAgent(ctx.paths, agentName);
  const t0 = Date.now();
  if (!agent) {
    const msg = `(스킵: \`agents/${agentName}.agent.md\`를 찾지 못해 이 단계를 건너뜁니다.)`;
    ctx.stream.markdown(msg);
    const durationMs = Date.now() - t0;
    appendStop(ctx, agentName, correlationId, startTs, durationMs, { skipped: true });
    return { agentName, output: '', correlationId, durationMs, skipped: true, attempt };
  }

  if (ctx.debug) ctx.stream.markdown(`> [debug] system prompt ${agent.systemPrompt.length} chars\n\n`);

  let output = '';
  let errorMessage: string | undefined;
  try {
    const userMessage = buildUserMessage(ctx, agent, priorResults, attempt);
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(agent.systemPrompt),
      vscode.LanguageModelChatMessage.User(userMessage),
    ];
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
  appendStop(ctx, agentName, correlationId, startTs, durationMs, errorMessage ? { error: errorMessage } : {});
  appendPipelineStep(ctx.paths, {
    pipeline_id: ctx.pipelineId,
    step: attempt ? `${agentName}#retry${attempt}` : agentName,
    output: output.slice(0, ctx.maxLoggedOutputChars ?? 4000),
    extra: { durationMs, correlationId, attempt, ...(errorMessage ? { error: errorMessage } : {}) },
  });
  ctx.logger?.info('agent stop', {
    agentName,
    durationMs,
    chars: output.length,
    correlationId,
    attempt,
    error: errorMessage,
  });

  return { agentName, output, correlationId, durationMs, errorMessage, attempt };
}

function appendStop(
  ctx: ExecutorContext,
  agentName: string,
  correlationId: string,
  startTs: string,
  durationMs: number,
  extra: Record<string, unknown>,
): void {
  appendFlow(ctx.paths, {
    event: 'SubagentStop',
    agentName,
    sessionId: ctx.sessionId,
    correlationId,
    startTs,
    stopTs: new Date().toISOString(),
    durationMs,
    source: 'extension-executor',
    ...extra,
  });
}

function testerFailed(ctx: ExecutorContext, result: StepResult): boolean {
  if (result.agentName !== 'Tester') return false;
  if (result.errorMessage) return true;
  const evidence = getTestEvidence(ctx.paths);
  if (evidence.ts) return !isEvidenceValid(ctx.paths);
  return outputLooksFail(result.output);
}

function outputLooksFail(output: string): boolean {
  if (!output.trim()) return true;
  if (/\b(pass|passed|성공|통과)\b/i.test(output) && !/\b(fail|failed|failure|실패|오류|error)\b/i.test(output)) {
    return false;
  }
  return /\b(fail|failed|failure|실패|오류|error)\b/i.test(output);
}

function shouldBlockRelease(ctx: ExecutorContext): boolean {
  const gate = getGateState(ctx.paths);
  if (!gate.requiredSince) return false;
  return !isEvidenceValid(ctx.paths);
}

function blockRelease(ctx: ExecutorContext, results: StepResult[]): StepResult {
  const correlationId = newCorrelationId();
  const msg = 'Release 차단: 파일 변경 이후 유효한 PASS 테스트 증거가 없습니다.';
  ctx.stream.markdown(
    `\n\n---\n\n### ⛔ Release gate 차단\n\n${msg}\n\n` +
    '`maestro_run_terminal`로 테스트 명령을 실행해 `logs/test-evidence.json`에 PASS 증거를 남긴 뒤 다시 Release 하세요.\n',
  );
  appendPipelineStep(ctx.paths, {
    pipeline_id: ctx.pipelineId,
    step: 'Release#blocked',
    output: msg,
    extra: { gate: 'test-evidence', requiredSince: getGateState(ctx.paths).requiredSince },
  });
  ctx.logger?.warn('release blocked by test gate', { results: results.length });
  return {
    agentName: 'Release',
    output: msg,
    correlationId,
    durationMs: 0,
    skipped: true,
    gateBlocked: true,
    errorMessage: msg,
  };
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
        if (ctx.streamAgentOutputs !== false) ctx.stream.markdown(part.value);
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
  attempt: number,
): string {
  const parts: string[] = [];
  if (ctx.maestroContext.trim()) {
    parts.push('## [Maestro 컨텍스트]');
    parts.push(ctx.maestroContext);
  }
  if (priorResults.length > 0) {
    parts.push('## [이전 단계 결과]');
    for (const prior of priorResults) {
      const maxChars = ctx.maxPriorOutputChars ?? 4000;
      const snippet = prior.output.length > maxChars
        ? prior.output.slice(0, maxChars) + '\n...(생략)'
        : prior.output;
      parts.push(`### ${prior.agentName}${prior.attempt ? ` retry ${prior.attempt}` : ''}\n${snippet || '(빈 출력)'}`);
    }
  }

  parts.push('## [원본 요청]');
  parts.push(ctx.userTask);
  parts.push('## [이번 단계 임무]');
  const toolNote = ctx.enableTools === false
    ? '도구 호출은 비활성화되어 있다.'
    : '필요하면 `maestro_read_file`, `maestro_write_file`, `maestro_run_terminal` 도구를 사용한다.';
  const testerNote = agent.name === 'Tester'
    ? 'Tester는 반드시 적절한 테스트 명령을 `maestro_run_terminal`로 실행하고 PASS/FAIL 근거를 남긴다.'
    : '';
  const releaseNote = agent.name === 'Release'
    ? 'Release는 test-gate PASS 증거가 없으면 완료 선언을 하지 않는다.'
    : '';
  parts.push(
    `당신은 **${agent.name}** 입니다. 위 시스템 프롬프트의 역할 정의에 따라 이번 단계 결과물을 출력하세요. ` +
    `배지/파이프라인 헤더는 extension UI가 이미 출력했으므로 반복하지 마세요. ${toolNote} ${testerNote} ${releaseNote} ` +
    (attempt ? `이번 호출은 재시도 ${attempt}회차이므로 이전 실패 원인을 명시적으로 고치세요.` : ''),
  );
  return parts.join('\n\n');
}
