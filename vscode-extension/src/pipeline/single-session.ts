import * as vscode from 'vscode';
import { loadAgent } from '../agents/loader';
import { appendPipelineStep } from '../state/pipeline-log';
import { HarnessPaths } from '../state/paths';
import { appendFlow, newCorrelationId } from '../state/subagent-flow';
import { getGateState, getTestEvidence, isEvidenceValid } from '../state/test-gate';
import { MAESTRO_READONLY_TOOL_NAMES, MAESTRO_TOOL_NAMES } from '../tools/registry';
import { loadPipelineConfig } from './config';
import type { StepResult } from './executor';

export interface SingleSessionPipelineContext {
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
  maxLoggedOutputChars?: number;
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  toolMode?: 'full' | 'read-only';
  logger?: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
}

interface ModelLoopResult {
  output: string;
  toolCallCount: number;
}

export async function executeSingleSessionPipeline(
  steps: string[],
  ctx: SingleSessionPipelineContext,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  if (steps.length === 0) return results;

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      [
        '## [Maestro single-session context]',
        'Extension이 같은 messages 배열을 유지하며 아래 파이프라인을 순서대로 직접 실행한다.',
        `pipeline: ${steps.join(' -> ')}`,
        '각 단계는 지정된 agent prompt를 적용하되, 이전 단계의 assistant/tool 결과를 같은 세션 문맥으로 참조한다.',
        '',
        ctx.maestroContext,
      ].join('\n'),
    ),
  ];

  const config = loadPipelineConfig(ctx.paths);
  const maxTesterRetries = Math.max(0, config.maxTesterRetries ?? 3);
  const hasImplementer = steps.includes('Implementer');

  for (let i = 0; i < steps.length; i++) {
    if (ctx.cancellation.isCancellationRequested) break;
    const agentName = steps[i];

    if (agentName === 'Release' && shouldBlockRelease(ctx)) {
      const blocked = blockRelease(ctx);
      results.push(blocked);
      break;
    }

    const result = await runStep(agentName, i + 1, steps.length, ctx, messages, 0);
    results.push(result);

    if (agentName === 'Tester' && testerFailed(ctx, result) && hasImplementer) {
      for (let retry = 1; retry <= maxTesterRetries; retry++) {
        if (ctx.cancellation.isCancellationRequested) break;
        ctx.stream.markdown(
          '\n\n> 🔁 Tester 실패 감지 — 같은 세션에서 Implementer 재시도 ' + retry + '/' + maxTesterRetries + ' 후 Tester 재검증\n\n',
        );
        const implRetry = await runStep('Implementer', i + 1, steps.length, ctx, messages, retry);
        results.push(implRetry);
        const testerRetry = await runStep('Tester', i + 1, steps.length, ctx, messages, retry);
        results.push(testerRetry);
        if (!testerFailed(ctx, testerRetry)) break;
      }
    }
  }

  return results;
}

async function runStep(
  agentName: string,
  stepNumber: number,
  totalSteps: number,
  ctx: SingleSessionPipelineContext,
  messages: vscode.LanguageModelChatMessage[],
  attempt: number,
): Promise<StepResult> {
  const correlationId = newCorrelationId();
  const startTs = new Date().toISOString();
  appendFlow(ctx.paths, {
    event: 'SubagentStart',
    agentName,
    sessionId: ctx.sessionId,
    correlationId,
    source: 'extension-single-session',
    ...(attempt ? { attempt } : {}),
  });
  ctx.logger?.info('single-session agent start', { agentName, stepNumber, total: totalSteps, correlationId, attempt });

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

  let output = '';
  let toolCallCount = 0;
  let errorMessage: string | undefined;
  try {
    messages.push(vscode.LanguageModelChatMessage.User(buildStepMessage(ctx, agentName, agent.systemPrompt, attempt)));
    const loop = await runModelLoop(ctx, messages);
    output = loop.output;
    toolCallCount = loop.toolCallCount;
    if (ctx.streamAgentOutputs === false) {
      ctx.stream.markdown(`_(출력 ${output.length} chars 생성됨 — 로그에 기록)_\n`);
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
    ctx.stream.markdown(`\n\n⚠️ ${agentName} 실행 실패: ${errorMessage}\n`);
    ctx.logger?.error('single-session agent failed', { agentName, errorMessage });
  }

  const durationMs = Date.now() - t0;
  const maxLogged = ctx.maxLoggedOutputChars ?? 4000;
  const shortSummary = summarizeOutput(output);
  const truncated = output.length > maxLogged;
  appendStop(ctx, agentName, correlationId, startTs, durationMs, errorMessage ? { error: errorMessage } : {});
  appendPipelineStep(ctx.paths, {
    pipeline_id: ctx.pipelineId,
    step: attempt ? `${agentName}#retry${attempt}` : agentName,
    output: output.slice(0, maxLogged),
    extra: {
      durationMs,
      correlationId,
      attempt,
      singleSession: true,
      toolCallCount,
      truncated,
      shortSummary,
      ...(errorMessage ? { error: errorMessage } : {}),
    },
  });
  ctx.logger?.info('single-session agent stop', {
    agentName,
    durationMs,
    chars: output.length,
    toolCallCount,
    truncated,
    correlationId,
    attempt,
    error: errorMessage,
  });

  const stepSec = (durationMs / 1000).toFixed(1);
  if (!errorMessage) {
    ctx.stream.markdown(`\n> ✅ **${agentName}** 완료 (${stepSec}s, ${output.length} chars)\n`);
  } else {
    ctx.stream.markdown(`\n> ❌ **${agentName}** 실패 (${stepSec}s): ${errorMessage}\n`);
  }

  return {
    agentName,
    output,
    shortSummary,
    truncated,
    correlationId,
    durationMs,
    errorMessage,
    attempt,
  };
}

function buildStepMessage(
  ctx: SingleSessionPipelineContext,
  agentName: string,
  systemPrompt: string,
  attempt: number,
): string {
  const toolNote = ctx.toolMode === 'read-only'
    ? '읽기 전용 모드다. 파일 쓰기, 터미널 실행, git 작업은 하지 않는다.'
    : '필요하면 Maestro 도구를 사용한다. Tester는 테스트 명령 증거를 남기고, Release는 gate를 지킨다.';
  return [
    `## [Single-session pipeline step: ${agentName}${attempt ? ` retry ${attempt}` : ''}]`,
    '이 단계에서는 아래 agent instruction을 현재 역할로 적용한다.',
    '이전 단계 출력과 도구 결과는 같은 messages 세션 안에 이미 포함되어 있다.',
    '',
    '## [Agent instruction]',
    systemPrompt,
    '',
    '## [Original user task]',
    ctx.userTask,
    '',
    '## [Step instruction]',
    `당신은 **${agentName}** 입니다. 배지/파이프라인 헤더는 반복하지 말고, 이 단계 결과만 출력하세요. ${toolNote}`,
  ].join('\n');
}

async function runModelLoop(
  ctx: SingleSessionPipelineContext,
  messages: vscode.LanguageModelChatMessage[],
): Promise<ModelLoopResult> {
  const allowed = ctx.toolMode === 'read-only' ? MAESTRO_READONLY_TOOL_NAMES : MAESTRO_TOOL_NAMES;
  const tools = vscode.lm.tools.filter(t => allowed.includes(t.name));
  const maxRounds = tools.length > 0 ? 4 : 1;
  const outputCap = (ctx.maxLoggedOutputChars ?? 4000) * 2;
  let output = '';
  let toolCallCount = 0;

  for (let round = 0; round < maxRounds; round++) {
    const response = await ctx.model.sendRequest(messages, {
      tools,
      toolMode: tools.length > 0 ? vscode.LanguageModelChatToolMode.Auto : undefined,
      justification: 'Maestro extension-driven single-session pipeline step.',
    }, ctx.cancellation);

    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const part of response.stream) {
      if (ctx.cancellation.isCancellationRequested) break;
      if (part instanceof vscode.LanguageModelTextPart) {
        assistantParts.push(part);
        if (output.length < outputCap) output += part.value;
        if (ctx.streamAgentOutputs !== false) ctx.stream.markdown(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        assistantParts.push(part);
        toolCalls.push(part);
        toolCallCount++;
        ctx.logger?.info('single-session step tool call requested', { name: part.name, input: part.input });
        ctx.stream.markdown(`\n> 🔧 \`${part.name}\`\n`);
      }
    }

    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      const result = await vscode.lm.invokeTool(call.name, {
        input: call.input,
        toolInvocationToken: ctx.toolInvocationToken,
      }, ctx.cancellation);
      messages.push(vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(call.callId, result.content),
      ]));
      ctx.logger?.info('single-session step tool call completed', { name: call.name, callId: call.callId });
    }
  }

  return { output, toolCallCount };
}

function appendStop(
  ctx: SingleSessionPipelineContext,
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
    source: 'extension-single-session',
    ...extra,
  });
}

function testerFailed(ctx: SingleSessionPipelineContext, result: StepResult): boolean {
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

function shouldBlockRelease(ctx: SingleSessionPipelineContext): boolean {
  const gate = getGateState(ctx.paths);
  if (!gate.requiredSince) return false;
  return !isEvidenceValid(ctx.paths);
}

function blockRelease(ctx: SingleSessionPipelineContext): StepResult {
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
    extra: { gate: 'test-evidence', requiredSince: getGateState(ctx.paths).requiredSince, singleSession: true },
  });
  ctx.logger?.warn('single-session release blocked by test gate');
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

function summarizeOutput(output: string): string {
  const normalized = output.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 240);
}
