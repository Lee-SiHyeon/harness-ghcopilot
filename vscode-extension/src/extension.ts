import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { callMaestroRouter, extractBadge, routerScriptPath, stripRouterDisplayDirectives } from './router-bridge';
import { HarnessPaths } from './state/paths';
import { clearActionItems, loadActionItemsCount } from './state/action-items';
import { appendFlow, newCorrelationId } from './state/subagent-flow';
import { executePipeline } from './pipeline/executor';
import { MaestroTreeProvider } from './sidebar-view';
import { MaestroStatusBar } from './status-bar';
import { registerCommands } from './commands';
import { registerTools } from './tools/registry';
import { HarnessWatcher } from './watcher';
import { createLogger, MaestroLogger } from './logging';
import { inspectGitChanges, isGitChangeQuery, renderGitChangeReport } from './local-git';

const PARTICIPANT_ID = 'maestro';
const CONFIG_SECTION = 'maestroChat';

type ExecutorMode = 'passthrough' | 'multi-agent';
let logger: MaestroLogger | null = null;

interface HarnessDiscovery {
  harnessPath: string;
  source: 'setting' | 'workspace-subfolder' | 'workspace-is-harness';
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
    return { harnessPath: resolved, source: 'setting' };
  }

  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    const fsPath = f.uri.fsPath;
    const sub = path.join(fsPath, '.github');
    if (fs.existsSync(routerScriptPath(sub))) {
      return { harnessPath: sub, source: 'workspace-subfolder' };
    }
    if (path.basename(fsPath) === '.github' && fs.existsSync(routerScriptPath(fsPath))) {
      return { harnessPath: fsPath, source: 'workspace-is-harness' };
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

const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const debug = cfg.get<boolean>('debug', false);
  const timeoutMs = cfg.get<number>('routerTimeoutMs', 15_000);
  const executorMode = (cfg.get<string>('executorMode', 'multi-agent') as ExecutorMode);
  const modelFamily = (cfg.get<string>('modelFamily') || '').trim();
  const streamAgentOutputs = cfg.get<boolean>('streamAgentOutputs', true);
  const maxPriorOutputChars = cfg.get<number>('maxPriorStepChars', 4000);
  const maxLoggedOutputChars = cfg.get<number>('maxLoggedStepChars', 4000);

  const found = findHarness();
  if ('error' in found) {
    stream.markdown('⚠️ ' + found.error);
    return;
  }
  const paths = new HarnessPaths(found.harnessPath);
  const sessionId = newCorrelationId();
  logger?.info('chat request', {
    sessionId,
    harnessPath: found.harnessPath,
    source: found.source,
    executorMode,
    promptChars: request.prompt.length,
  });

  if (debug) {
    stream.markdown(`\n> [debug] harness: \`${found.harnessPath}\` (source: ${found.source}) | mode: \`${executorMode}\`\n\n`);
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

  stream.progress('Maestro router 분류 중…');
  let routerResult;
  try {
    routerResult = await callMaestroRouter(request.prompt, {
      harnessPath: found.harnessPath,
      timeoutMs,
    });
    logger?.info('router result', {
      sessionId,
      hookSpecificOutput: routerResult.hookSpecificOutput,
      decision: routerResult.decision,
      hasUserMessage: Boolean(routerResult.modifiedParameters?.userMessage),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger?.error('router failed', e);
    stream.markdown(`⚠️ Maestro router 호출 실패: \`${msg}\`\n\n`);
    if (debug) stream.markdown(`> harness: \`${found.harnessPath}\``);
    return;
  }

  const userMessage = routerResult.modifiedParameters?.userMessage || request.prompt;
  const modelUserMessage = stripRouterDisplayDirectives(userMessage);
  const badge = extractBadge(userMessage);

  if (badge) {
    stream.markdown('```\n' + badge + '\n```\n\n');
  } else {
    stream.markdown('> ⚠️ Maestro 분류 헤더 추출 실패\n\n');
    if (debug) stream.markdown('```\n[debug] userMessage head:\n' + userMessage.slice(0, 600) + '\n```\n\n');
  }

  if (routerResult.decision === 'ask' && routerResult.reason) {
    stream.markdown('\n---\n\n' + routerResult.reason);
    return;
  }

  let model: vscode.LanguageModelChat | undefined;
  try {
    const selector = modelFamily
      ? { vendor: 'copilot', family: modelFamily }
      : { vendor: 'copilot' };
    const models = await vscode.lm.selectChatModels(selector);
    model = models[0];
    logger?.info('model selected', {
      sessionId,
      requestedFamily: modelFamily || '(first available)',
      model: model ? { name: model.name, vendor: model.vendor, family: model.family } : null,
      candidates: models.length,
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
    const parsed = badge ? parseBadge(badge) : { intent: '', pipeline: [], classifier: '' };
    if (parsed.pipeline.length === 0) {
      stream.markdown('\n⚠️ multi-agent 모드인데 파이프라인을 파싱하지 못했습니다. passthrough로 폴백합니다.\n\n');
      await runPassthrough({ model, userMessage: modelUserMessage, stream, token });
      return;
    }
    if (debug) {
      stream.markdown(`> [debug] pipeline steps: ${JSON.stringify(parsed.pipeline)}\n\n`);
    }
    const actionCount = loadActionItemsCount(paths);
    await executePipeline(parsed.pipeline, {
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
      logger: logger ?? undefined,
    });
    if (actionCount > 0) {
      clearActionItems(paths);
      if (debug) stream.markdown(`\n> [debug] cleared ${actionCount} actionItems after multi-agent run\n`);
    }
    return;
  }

  await runPassthrough({ model, userMessage: modelUserMessage, stream, token });
};

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
  const treeView = vscode.window.createTreeView('maestroChat.sidebar', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 3) 상태바
  const statusBar = new MaestroStatusBar(resolveHarnessPath);
  context.subscriptions.push(statusBar);

  // 4) 통합 refresh — tree + statusBar 동시 갱신
  const refresh = () => {
    treeProvider.refresh();
    statusBar.refresh(resolveHarnessPath);
  };

  // 5) 명령들
  registerCommands(context, resolveHarnessPath, refresh);
  context.subscriptions.push(vscode.commands.registerCommand('maestroChat.showOutput', () => {
    logger?.show();
  }));

  // 6) vscode.lm 도구 등록 (Phase 3 스캐폴딩)
  registerTools(context, resolveHarnessPath);

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
