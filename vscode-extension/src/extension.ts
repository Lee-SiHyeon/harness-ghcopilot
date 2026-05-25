import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { callMaestroRouter, extractBadge, routerScriptPath } from './router-bridge';
import { HarnessPaths } from './state/paths';
import { clearActionItems, loadActionItemsCount } from './state/action-items';
import { appendFlow, newCorrelationId } from './state/subagent-flow';
import { executePipeline } from './pipeline/executor';

const PARTICIPANT_ID = 'maestro';
const CONFIG_SECTION = 'maestroChat';

type ExecutorMode = 'passthrough' | 'multi-agent';

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
      '3. `maestroChat.harnessPath` 설정에 clone한 `.github` 폴더의 절대 경로를 적으세요 ' +
      '(File → Preferences → Settings → "maestro chat" 검색).',
  };
}

/** badge 블록에서 작업 유형/파이프라인/분류 방식을 파싱. */
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
    // "자가비평 N건 처리" 같은 메타 단계는 실제 agent가 아니므로 제외
    .filter(s => !/^자가비평\s+\d+건/.test(s));
  const classifier = classifierMatch ? classifierMatch[1].trim() : '';
  return { intent, pipeline, classifier };
}

const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const debug = cfg.get<boolean>('debug', false);
  const timeoutMs = cfg.get<number>('routerTimeoutMs', 15_000);
  const executorMode = (cfg.get<string>('executorMode', 'passthrough') as ExecutorMode);

  // 1) harness 위치 결정
  const found = findHarness();
  if ('error' in found) {
    stream.markdown('⚠️ ' + found.error);
    return;
  }
  const paths = new HarnessPaths(found.harnessPath);
  const sessionId = newCorrelationId();

  if (debug) {
    stream.markdown(`\n> [debug] harness: \`${found.harnessPath}\` (source: ${found.source}) | mode: \`${executorMode}\`\n\n`);
  }

  // MaestroSessionStart 이벤트 기록 (기존 router도 기록하지만 extension 경로도 표시)
  appendFlow(paths, {
    event: 'MaestroSessionStart',
    agentName: 'Maestro',
    sessionId,
    source: 'extension-handler',
  });

  // 2) 분류기 호출 (기존 hook 로직 그대로 재사용)
  stream.progress('Maestro router 분류 중…');
  let routerResult;
  try {
    routerResult = await callMaestroRouter(request.prompt, {
      harnessPath: found.harnessPath,
      timeoutMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stream.markdown(`⚠️ Maestro router 호출 실패: \`${msg}\`\n\n`);
    if (debug) stream.markdown(`> harness: \`${found.harnessPath}\``);
    return;
  }

  const userMessage = routerResult.modifiedParameters?.userMessage || request.prompt;
  const badge = extractBadge(userMessage);

  // 3) ★ 배지 강제 출력
  if (badge) {
    stream.markdown('```\n' + badge + '\n```\n\n');
  } else {
    stream.markdown('> ⚠️ Maestro 분류 헤더 추출 실패\n\n');
    if (debug) stream.markdown('```\n[debug] userMessage head:\n' + userMessage.slice(0, 600) + '\n```\n\n');
  }

  // 4) HITL gate
  if (routerResult.decision === 'ask' && routerResult.reason) {
    stream.markdown('\n---\n\n' + routerResult.reason);
    return;
  }

  // 5) vscode.lm → Copilot LLM
  let model: vscode.LanguageModelChat | undefined;
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    model = models[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
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

  // 6) 실행 모드 분기
  if (executorMode === 'multi-agent') {
    const parsed = badge ? parseBadge(badge) : { intent: '', pipeline: [], classifier: '' };
    if (parsed.pipeline.length === 0) {
      stream.markdown('\n⚠️ multi-agent 모드인데 파이프라인을 파싱하지 못했습니다. passthrough로 폴백합니다.\n\n');
      await runPassthrough({ model, userMessage, stream, token });
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
      maestroContext: userMessage,
      stream,
      cancellation: token,
      model,
      debug,
    });
    // 미해결 actionItems가 라우터를 통해 주입됐을 가능성 — 실행 후 정리
    if (actionCount > 0) {
      clearActionItems(paths);
      if (debug) stream.markdown(`\n> [debug] cleared ${actionCount} actionItems after multi-agent run\n`);
    }
    return;
  }

  // passthrough (Phase 1 동작)
  await runPassthrough({ model, userMessage, stream, token });
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
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('symbol-event');
  context.subscriptions.push(participant);
}

export function deactivate(): void {
  // ChatParticipant는 subscriptions로 자동 dispose
}
