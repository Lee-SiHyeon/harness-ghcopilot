import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { callMaestroRouter, extractBadge, routerScriptPath, stripRouterDisplayDirectives } from './router-bridge';
import { HarnessPaths } from './state/paths';
import { clearActionItems, loadActionItemsCount } from './state/action-items';
import { appendFlow, newCorrelationId } from './state/subagent-flow';
import { executePipeline } from './pipeline/executor';
import { executeSingleSessionPipeline } from './pipeline/single-session';
import { MaestroTreeProvider } from './sidebar-view';
import { McpTreeProvider } from './mcp-view';
import { MaestroStatusBar } from './status-bar';
import { registerCommands } from './commands';
import { registerTools } from './tools/registry';
import { HarnessWatcher } from './watcher';
import { createLogger, MaestroLogger } from './logging';
import { inspectGitChanges, isGitChangeQuery, renderGitChangeReport } from './local-git';
import { finalizeRetrospective } from './state/retrospective';
import { buildBadge, buildInternalUserMessage, classifyPrompt } from './router/internal';
import { normalizePipeline, requiresAuditAndRelease } from './pipeline/config';
import { choosePreferredModel } from './model-selection';
import { renderLocalDirectAnswer } from './local-direct';

const PARTICIPANT_ID = 'maestro';
const CONFIG_SECTION = 'maestroChat';

type ExecutorMode = 'passthrough' | 'single-session' | 'multi-agent';
let logger: MaestroLogger | null = null;

function isReadOnlyIntent(intent: string): boolean {
  return ['query', 'question', 'inspect', 'review', 'plan', 'investigate', 'scout'].includes(intent);
}

interface HarnessDiscovery {
  harnessPath: string;
  workspaceRoot: string;
  source: 'setting' | 'workspace-subfolder' | 'workspace-is-harness';
  warning?: string;
}

function containsPath(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function workspaceRootForHarness(harnessPath: string): { workspaceRoot: string; matchedWorkspace: boolean } {
  const folders = vscode.workspace.workspaceFolders || [];
  const match = folders
    .map(f => f.uri.fsPath)
    .filter(root => containsPath(root, harnessPath))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return { workspaceRoot: path.resolve(match), matchedWorkspace: true };
  return { workspaceRoot: path.resolve(harnessPath), matchedWorkspace: false };
}

function findHarness(): HarnessDiscovery | { error: string } {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const settingPath = (cfg.get<string>('harnessPath') || '').trim();
  if (settingPath) {
    const resolved = path.resolve(settingPath);
    if (!fs.existsSync(routerScriptPath(resolved))) {
      return { error: `maestroChat.harnessPath="${settingPath}" 가 설정돼 있지만 ${path.join('hooks', 'scripts', 'maestro-router.js')}를 찾지 못했습니다.` };
    }
    if (path.basename(resolved) !== '.github') {
      return { error: `harnessPath의 마지막 폴더명이 ".github"가 아닙니다 ("${path.basename(resolved)}"). 라우터는 cwd/.github/... 구조를 가정합니다.` };
    }
    const root = workspaceRootForHarness(resolved);
    return {
      harnessPath: resolved,
      workspaceRoot: root.workspaceRoot,
      source: 'setting',
      warning: root.matchedWorkspace
        ? undefined
        : 'maestroChat.harnessPath가 열린 워크스페이스 밖을 가리켜 workspaceRoot를 harness 폴더로 제한했습니다.',
    };
  }

  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    const fsPath = f.uri.fsPath;
    const sub = path.join(fsPath, '.github');
    if (fs.existsSync(routerScriptPath(sub))) {
      return { harnessPath: sub, workspaceRoot: fsPath, source: 'workspace-subfolder' };
    }
    if (path.basename(fsPath) === '.github' && fs.existsSync(routerScriptPath(fsPath))) {
      return { harnessPath: fsPath, workspaceRoot: path.dirname(fsPath), source: 'workspace-is-harness' };
    }
  }

  return {
    error:
      'Maestro harness(.github 폴더)를 찾을 수 없습니다.\n\n' +
      '다음 중 하나를 시도하세요:\n' +
      '1. `.github` 폴더가 있는 프로젝트를 워크스페이스로 여세요.\n' +
      '2. clone한 `.github` 저장소 자체를 워크스페이스로 여세요.\n' +
      '3. `maestroChat.harnessPath` 설정에 clone한 `.github` 폴더의 절대 경로를 적으세요.',
  };
}

function resolveHarnessPath(): string | null {
  const found = findHarness();
  return 'error' in found ? null : found.harnessPath;
}

function resolveHarnessPaths(): HarnessPaths | null {
  const found = findHarness();
  return 'error' in found ? null : new HarnessPaths(found.harnessPath, found.workspaceRoot);
}

function parseBadge(badge: string): { intent: string; pipeline: string[]; classifier: string } {
  const intentMatch = badge.match(/🎯 \*\*작업 유형\*\*:\s*(.+)/);
  const pipelineMatch = badge.match(/📋 \*\*파이프라인\*\*:\s*(.+)/);
  const classifierMatch = badge.match(/🔍 \*\*분류 방식\*\*:\s*(.+)/);
  const intent = intentMatch ? intentMatch[1].trim() : '';
  const pipelineStr = pipelineMatch ? pipelineMatch[1].trim() : '';
  const pipeline = pipelineStr
    .split('→')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^자가비평\s+\d+건/.test(s));
  const classifier = classifierMatch ? classifierMatch[1].trim() : '';
  return { intent, pipeline, classifier };
}

const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const debug = cfg.get<boolean>('debug', false);
  const timeoutMs = cfg.get<number>('routerTimeoutMs', 15_000);
  const useLegacyRouter = cfg.get<boolean>('useLegacyRouter', false);
  const executorMode = (cfg.get<string>('executorMode', 'single-session') as ExecutorMode);
  const modelFamily = (cfg.get<string>('modelFamily') || '').trim();
  const streamAgentOutputs = cfg.get<boolean>('streamAgentOutputs', true);
  const maxPriorOutputChars = cfg.get<number>('maxPriorStepChars', 4000);
  const maxLoggedOutputChars = cfg.get<number>('maxLoggedStepChars', 4000);

  const found = findHarness();
  if ('error' in found) {
    stream.markdown('⚠️ ' + found.error);
    return;
  }
  const paths = new HarnessPaths(found.harnessPath, found.workspaceRoot);
  const sessionId = newCorrelationId();
  logger?.info('chat request', {
    sessionId,
    harnessPath: found.harnessPath,
    workspaceRoot: found.workspaceRoot,
    source: found.source,
    executorMode,
    promptChars: request.prompt.length,
  });
  if (found.warning) logger?.warn('harness discovery warning', { warning: found.warning, harnessPath: found.harnessPath, workspaceRoot: found.workspaceRoot });

  if (debug) {
    stream.markdown(`\n> [debug] harness: \`${found.harnessPath}\` | workspace: \`${found.workspaceRoot}\` (source: ${found.source}) | mode: \`${executorMode}\`\n\n`);
    if (found.warning) stream.markdown(`> [debug] warning: ${found.warning}\n\n`);
  }

  appendFlow(paths, {
    event: 'MaestroSessionStart',
    agentName: 'Maestro',
    sessionId,
    source: 'extension-handler',
  });

  if (isGitChangeQuery(request.prompt)) {
    stream.markdown('```\n🎯 **작업 유형**: workspace-inspection\n📋 **파이프라인**: Git Inspector → Release\n🔍 **분류 방식**: Extension deterministic route\n```\n\n');
    const gitCorrelationId = newCorrelationId();
    const startTs = new Date().toISOString();
    appendFlow(paths, {
      event: 'SubagentStart',
      agentName: 'Git Inspector',
      sessionId,
      correlationId: gitCorrelationId,
      source: 'extension-deterministic-route',
    });
    const report = inspectGitChanges(found.harnessPath);
    if (!report) {
      stream.markdown('⚠️ git 저장소를 찾지 못했습니다. standalone `.github` clone이면 해당 폴더가 git repo인지 확인하세요.');
      logger?.warn('git change query without git repository', { harnessPath: found.harnessPath });
      appendFlow(paths, {
        event: 'SubagentStop',
        agentName: 'Git Inspector',
        sessionId,
        correlationId: gitCorrelationId,
        startTs,
        stopTs: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startTs),
        source: 'extension-deterministic-route',
        error: 'git repository not found',
      });
      return;
    }
    const rendered = renderGitChangeReport(report);
    logger?.info('git change report generated', {
      sessionId,
      cwd: report.cwd,
      statusChars: report.status.length,
      unstagedStatChars: report.unstagedStat.length,
      stagedStatChars: report.stagedStat.length,
    });
    appendFlow(paths, {
      event: 'SubagentStop',
      agentName: 'Git Inspector',
      sessionId,
      correlationId: gitCorrelationId,
      startTs,
      stopTs: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(startTs),
      source: 'extension-deterministic-route',
    });
    stream.markdown(rendered);
    return;
  }

  stream.progress(useLegacyRouter ? 'Legacy Maestro router 분류 중…' : 'Extension router 분류 중…');
  let modelUserMessage = '';
  let badge = '';
  let parsed = { intent: '', pipeline: [] as string[], classifier: '' };
  let routerDecision: string | undefined;
  let routerReason: string | undefined;
  if (useLegacyRouter) {
    try {
      const routerResult = await callMaestroRouter(request.prompt, {
        harnessPath: found.harnessPath,
        timeoutMs,
      });
      logger?.info('legacy router result', {
        sessionId,
        harnessPath: found.harnessPath,
        workspaceRoot: found.workspaceRoot,
        hookSpecificOutput: routerResult.hookSpecificOutput,
        decision: routerResult.decision,
        hasUserMessage: Boolean(routerResult.modifiedParameters?.userMessage),
      });
      const userMessage = routerResult.modifiedParameters?.userMessage || request.prompt;
      modelUserMessage = stripRouterDisplayDirectives(userMessage);
      badge = extractBadge(userMessage);
      parsed = badge ? parseBadge(badge) : parsed;
      routerDecision = routerResult.decision;
      routerReason = routerResult.reason;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger?.error('legacy router failed', e);
      stream.markdown(`⚠️ Legacy Maestro router 호출 실패: \`${msg}\`\n\n`);
      if (debug) stream.markdown(`> harness: \`${found.harnessPath}\``);
      return;
    }
  } else {
    let analysis = classifyPrompt(request.prompt, paths);
    // actionItems override: trivial intent but unresolved items exist → bump to inspect
    const pendingItems = loadActionItemsCount(paths);
    if (pendingItems > 0 && (analysis.intent === 'question' || analysis.intent === 'query')) {
      analysis = { ...analysis, intent: 'inspect', pipeline: normalizePipeline('inspect', ['Inspector']), reason: `[extension-router] actionItems override (${pendingItems}건 미해결)` };
    }
    badge = buildBadge(analysis);
    parsed = { intent: analysis.intent, pipeline: analysis.pipeline, classifier: analysis.classifier };
    modelUserMessage = buildInternalUserMessage(analysis, request.prompt, paths);
    logger?.info('extension router result', {
      sessionId,
      harnessPath: found.harnessPath,
      workspaceRoot: found.workspaceRoot,
      intent: analysis.intent,
      pipeline: analysis.pipeline,
      complexity: analysis.complexity,
      stacks: analysis.stacks,
      reason: analysis.reason,
      pendingActionItems: pendingItems,
    });
  }

  // 채팅 히스토리 주입 (최근 5턴, 싱글세션/패스스루 모두 활용)
  const historyTurns = ((context as any).history ?? []).slice(-10);
  if (historyTurns.length > 0) {
    const historyLines: string[] = [];
    for (const turn of historyTurns) {
      if (turn instanceof vscode.ChatRequestTurn) {
        historyLines.push(`User: ${(turn as any).prompt}`);
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const textParts = ((turn as any).response as unknown[])
          .filter((p: unknown) => p instanceof vscode.ChatResponseMarkdownPart)
          .map((p: unknown) => (p as vscode.ChatResponseMarkdownPart).value.value)
          .join('');
        if (textParts.trim()) {
          historyLines.push(`Assistant: ${textParts.trim().slice(0, 500)}`);
        }
      }
    }
    if (historyLines.length > 0) {
      modelUserMessage = '## [\uc774\uc804 \ub300\ud654 \uae30\ub85d]\n' + historyLines.join('\n') + '\n\n---\n\n' + modelUserMessage;
    }
  }

  if (badge) {
    stream.markdown('```\n' + badge + '\n```\n\n');
  } else {
    stream.markdown('> ⚠️ Maestro 분류 헤더 추출 실패\n\n');
    if (debug) stream.markdown('```\n[debug] userMessage head:\n' + modelUserMessage.slice(0, 600) + '\n```\n\n');
  }

  // actionItems 미해결 배너 — debug 설정 없이도 항상 표시
  const actionItemCountForBanner = loadActionItemsCount(paths);
  if (actionItemCountForBanner > 0) {
    stream.markdown(`> ⚠️ **미해결 actionItems ${actionItemCountForBanner}건** — 이번 실행에서 먼저 해소됩니다\n\n`);
  }

  if (debug && !useLegacyRouter) {
    const parsedAnalysis = { intent: parsed.intent, pipeline: parsed.pipeline, reason: routerReason };
    stream.markdown(
      `> [debug] intent=\`${parsed.intent}\` pipeline=\`${parsed.pipeline.join(' → ') || '없음'}\`\n` +
      (routerReason ? `> [debug] 이유: ${routerReason}\n` : '') +
      (actionItemCountForBanner > 0 ? `> [debug] actionItems: ${actionItemCountForBanner}건\n` : '') +
      '\n',
    );
    void parsedAnalysis;
  }

  if (routerDecision === 'ask' && routerReason) {
    stream.markdown('\n---\n\n' + routerReason);
    return;
  }

  const localDirectAnswer = renderLocalDirectAnswer(request.prompt, parsed.intent, parsed.pipeline);
  if (localDirectAnswer) {
    logger?.info('local direct answer', { sessionId, intent: parsed.intent, promptChars: request.prompt.length });
    stream.markdown(localDirectAnswer);
    return;
  }

  let model: vscode.LanguageModelChat | undefined;
  try {
    let candidateCount = 1;
    if (modelFamily) {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: modelFamily });
      model = models[0];
      candidateCount = models.length;
    } else {
      model = request.model || choosePreferredModel(await vscode.lm.selectChatModels({ vendor: 'copilot' }));
    }
    logger?.info('model selected', {
      sessionId,
      requestedFamily: modelFamily || '(chat UI selected)',
      model: model ? { name: model.name, vendor: model.vendor, family: model.family } : null,
      candidates: candidateCount,
      selectionStrategy: modelFamily ? 'configured-family-first' : 'chat-request-model',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger?.error('model selection failed', e);
    stream.markdown(`\n⚠️ Language Model 선택 실패: \`${msg}\``);
    return;
  }
  if (!model) {
    stream.markdown('\n⚠️ Copilot 언어 모델을 찾을 수 없습니다. GitHub Copilot 확장 + 로그인을 확인하세요.');
    return;
  }
  if (debug) {
    stream.markdown(`\n> [debug] model: ${model.name} (${model.vendor}/${model.family})\n\n`);
  }

  if (executorMode === 'multi-agent') {
    if (parsed.pipeline.length === 0) {
      logger?.info('direct answer fallback', { sessionId, intent: parsed.intent, executorMode, toolMode: 'none' });
      await runPassthrough({ model, userMessage: modelUserMessage, stream, token });
      return;
    }
    if (debug) {
      stream.markdown(`> [debug] pipeline steps: ${JSON.stringify(parsed.pipeline)}\n\n`);
    }
    const actionCount = loadActionItemsCount(paths);
    const startedAt = Date.now();
    const toolMode = isReadOnlyIntent(parsed.intent) ? 'read-only' : 'full';
    logger?.info('pipeline start', {
      sessionId,
      harnessPath: found.harnessPath,
      workspaceRoot: found.workspaceRoot,
      pipeline: parsed.pipeline,
      intent: parsed.intent,
      toolMode,
      model: { name: model.name, vendor: model.vendor, family: model.family },
      executorMode,
    });
    const results = await executePipeline(parsed.pipeline, {
      paths,
      pipelineId: parsed.intent || 'unknown',
      sessionId,
      userTask: request.prompt,
      maestroContext: modelUserMessage,
      stream,
      cancellation: token,
      model,
      debug,
      streamAgentOutputs,
      maxPriorOutputChars,
      maxLoggedOutputChars,
      toolInvocationToken: request.toolInvocationToken,
      enableTools: true,
      toolMode,
      logger: logger ?? undefined,
    });
    const pipelineSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    stream.markdown(`\n> ⏱️ 파이프라인 완료: **${pipelineSec}s** | 단계: ${results.length} | intent: \`${parsed.intent}\`\n`);
    logger?.info('pipeline complete', { sessionId, durationMs: Date.now() - startedAt, steps: results.length, intent: parsed.intent });
    if (actionCount > 0 && requiresAuditAndRelease(parsed.intent)) {
      clearActionItems(paths);
      if (debug) stream.markdown(`\n> [debug] cleared ${actionCount} actionItems after multi-agent run\n`);
    }
    finalizeRetrospective(paths, {
      sessionId,
      intent: parsed.intent || 'unknown',
      plannedPipeline: parsed.pipeline,
      results,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  if (executorMode === 'single-session') {
    if (parsed.pipeline.length === 0) {
      await runSingleSession({ model, userMessage: modelUserMessage, stream, token, toolInvocationToken: request.toolInvocationToken, intent: parsed.intent });
      return;
    }
    const actionCount = loadActionItemsCount(paths);
    const startedAt = Date.now();
    const toolMode = isReadOnlyIntent(parsed.intent) ? 'read-only' : 'full';
    logger?.info('single-session pipeline start', {
      sessionId,
      harnessPath: found.harnessPath,
      workspaceRoot: found.workspaceRoot,
      pipeline: parsed.pipeline,
      intent: parsed.intent,
      toolMode,
      model: { name: model.name, vendor: model.vendor, family: model.family },
      executorMode,
    });
    const results = await executeSingleSessionPipeline(parsed.pipeline, {
      paths,
      pipelineId: parsed.intent || 'unknown',
      sessionId,
      userTask: request.prompt,
      maestroContext: modelUserMessage,
      stream,
      cancellation: token,
      model,
      debug,
      streamAgentOutputs,
      maxLoggedOutputChars,
      toolInvocationToken: request.toolInvocationToken,
      toolMode,
      logger: logger ?? undefined,
    });
    const pipelineSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    stream.markdown(`\n> ⏱️ single-session 파이프라인 완료: **${pipelineSec}s** | 단계: ${results.length} | intent: \`${parsed.intent}\`\n`);
    logger?.info('single-session pipeline complete', { sessionId, durationMs: Date.now() - startedAt, steps: results.length, intent: parsed.intent });
    if (actionCount > 0 && requiresAuditAndRelease(parsed.intent)) {
      clearActionItems(paths);
      if (debug) stream.markdown(`\n> [debug] cleared ${actionCount} actionItems after single-session run\n`);
    }
    finalizeRetrospective(paths, {
      sessionId,
      intent: parsed.intent || 'unknown',
      plannedPipeline: parsed.pipeline,
      results,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  await runPassthrough({ model, userMessage: modelUserMessage, stream, token });
};


async function runSingleSession(args: {
  model: vscode.LanguageModelChat;
  userMessage: string;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  intent?: string;
}): Promise<void> {
  const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(args.userMessage)];
  const OUTER_TOOL_NAMES = ['maestro_read_file', 'maestro_list_files', 'maestro_search_files'];
  const tools = vscode.lm.tools.filter(t => OUTER_TOOL_NAMES.includes(t.name));
  let toolCallCount = 0;
  try {
    const maxRounds = tools.length > 0 ? 10 : 1;
    for (let round = 0; round < maxRounds; round++) {
      const response = await args.model.sendRequest(messages, {
        tools,
        toolMode: tools.length > 0 ? vscode.LanguageModelChatToolMode.Auto : undefined,
        justification: 'Maestro direct answer with read-only workspace tools.',
      }, args.token);
      const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      for await (const part of response.stream) {
        if (args.token.isCancellationRequested) return;
        if (part instanceof vscode.LanguageModelTextPart) {
          assistantParts.push(part);
          args.stream.markdown(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          assistantParts.push(part);
          toolCalls.push(part);
          toolCallCount++;
          logger?.info('single-session tool call requested', { name: part.name, input: part.input });
          args.stream.markdown(`\n> 🔧 \`${part.name}\`\n`);
        }
      }
      if (toolCalls.length === 0) break;
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
      for (const call of toolCalls) {
        const result = await vscode.lm.invokeTool(call.name, {
          input: call.input,
          toolInvocationToken: args.toolInvocationToken,
        }, args.token);
        messages.push(vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(call.callId, result.content),
        ]));
        logger?.info('single-session tool call completed', { name: call.name, callId: call.callId });
      }
    }
    logger?.info('single-session complete', { toolCallCount, messageCount: messages.length });
  } catch (e) {
    logger?.error('single-session failed', e);
    if (e instanceof vscode.LanguageModelError) {
      args.stream.markdown(`\n\n⚠️ LLM 오류 (${e.code}): ${e.message}`);
    } else if (e instanceof Error) {
      args.stream.markdown(`\n\n⚠️ 응답 생성 실패: ${e.message}`);
    } else {
      throw e;
    }
  }
}
async function runPassthrough(args: {
  model: vscode.LanguageModelChat;
  userMessage: string;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
}): Promise<void> {
  const messages = [vscode.LanguageModelChatMessage.User(args.userMessage)];
  try {
    const response = await args.model.sendRequest(messages, {}, args.token);
    for await (const fragment of response.text) {
      if (args.token.isCancellationRequested) return;
      args.stream.markdown(fragment);
    }
  } catch (e) {
    logger?.error('passthrough failed', e);
    if (e instanceof vscode.LanguageModelError) {
      args.stream.markdown(`\n\n⚠️ LLM 오류 (${e.code}): ${e.message}`);
    } else if (e instanceof Error) {
      args.stream.markdown(`\n\n⚠️ 응답 생성 실패: ${e.message}`);
    } else {
      throw e;
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Maestro Chat');
  logger = createLogger(output);
  context.subscriptions.push(output);
  logger.info('activate');

  // 1) ChatParticipant
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('symbol-event');
  context.subscriptions.push(participant);

  // 2) 사이드바 TreeView
  const treeProvider = new MaestroTreeProvider(resolveHarnessPath);
  const mcpProvider = new McpTreeProvider(resolveHarnessPath);
  const treeView = vscode.window.createTreeView('maestroChat.sidebar', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const mcpView = vscode.window.createTreeView('maestroChat.mcp', {
    treeDataProvider: mcpProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(mcpView);

  // 3) 상태바
  const statusBar = new MaestroStatusBar(resolveHarnessPath);
  context.subscriptions.push(statusBar);

  // 4) 통합 refresh — tree + statusBar 동시 갱신
  const refresh = () => {
    treeProvider.refresh();
    mcpProvider.refresh();
    statusBar.refresh(resolveHarnessPath);
  };

  // 5) 명령들
  registerCommands(context, resolveHarnessPath, refresh);
  context.subscriptions.push(vscode.commands.registerCommand('maestroChat.showOutput', () => {
    logger?.show();
  }));

  // 6) vscode.lm 도구 등록 (Phase 3 스캐폴딩)
  registerTools(context, resolveHarnessPaths);

  // 7) 로그 파일 변경 → 자동 refresh
  const watcher = new HarnessWatcher(refresh);
  watcher.watch(resolveHarnessPath());
  context.subscriptions.push({ dispose: () => watcher.dispose() });

  // 8) 설정/워크스페이스 변경 → harness 재발견 + refresh + watch
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        logger?.info('configuration changed');
        watcher.watch(resolveHarnessPath());
        refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      logger?.info('workspace folders changed');
      watcher.watch(resolveHarnessPath());
      refresh();
    }),
  );
}

export function deactivate(): void {
  /* ChatParticipant + subscriptions로 자동 dispose */
}










