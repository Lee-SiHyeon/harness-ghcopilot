import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { callMaestroRouter, extractBadge, routerScriptPath } from './router-bridge';

const PARTICIPANT_ID = 'maestro';
const CONFIG_SECTION = 'maestroChat';

interface HarnessDiscovery {
  /** Absolute path to the `.github` directory. */
  harnessPath: string;
  /** How we found it (for debug display). */
  source: 'setting' | 'workspace-subfolder' | 'workspace-is-harness';
}

/**
 * Decide which .github directory to drive.
 *
 * Priority:
 *   1. `maestroChat.harnessPath` setting (explicit user config)
 *   2. workspace folder가 `.github/hooks/scripts/maestro-router.js`를 가지면 → `<workspace>/.github`
 *   3. workspace folder 자체가 harness (basename==='.github' AND hooks/scripts/maestro-router.js 존재) → 그 자체
 */
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
    // 케이스 2: 워크스페이스 안에 .github/ 서브폴더
    const sub = path.join(fsPath, '.github');
    if (fs.existsSync(routerScriptPath(sub))) {
      return { harnessPath: sub, source: 'workspace-subfolder' };
    }
    // 케이스 3: 워크스페이스 폴더 자체가 .github
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

const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const debug = cfg.get<boolean>('debug', false);
  const timeoutMs = cfg.get<number>('routerTimeoutMs', 15_000);

  // 1) harness 위치 결정
  const found = findHarness();
  if ('error' in found) {
    stream.markdown('⚠️ ' + found.error);
    return;
  }
  if (debug) {
    stream.markdown(`\n> [debug] harness: \`${found.harnessPath}\` (source: ${found.source})\n\n`);
  }

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
    if (debug) {
      stream.markdown(`> harness: \`${found.harnessPath}\``);
    }
    return;
  }

  const userMessage = routerResult.modifiedParameters?.userMessage || request.prompt;
  const badge = extractBadge(userMessage);

  // 3) ★ 배지 강제 출력 — UI에 100% 표시
  if (badge) {
    stream.markdown('```\n' + badge + '\n```\n\n');
  } else {
    stream.markdown(
      '> ⚠️ Maestro 분류 헤더 추출 실패 (router 출력 형식 변경 또는 단순 패스스루)\n\n'
    );
    if (debug) {
      stream.markdown('```\n[debug] userMessage head:\n' + userMessage.slice(0, 600) + '\n```\n\n');
    }
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
    stream.markdown(
      '\n⚠️ Copilot 언어 모델을 찾을 수 없습니다. GitHub Copilot 확장 + 로그인을 확인하세요.'
    );
    return;
  }
  if (debug) {
    stream.markdown(`\n> [debug] model: ${model.name} (${model.vendor}/${model.family})\n\n`);
  }

  // 6) Maestro userMessage 전체를 LLM에 전달 (배지+todo+회고+원본)
  const messages = [vscode.LanguageModelChatMessage.User(userMessage)];

  try {
    const response = await model.sendRequest(messages, {}, token);
    for await (const fragment of response.text) {
      if (token.isCancellationRequested) return;
      stream.markdown(fragment);
    }
  } catch (e) {
    if (e instanceof vscode.LanguageModelError) {
      stream.markdown(`\n\n⚠️ LLM 오류 (${e.code}): ${e.message}`);
    } else if (e instanceof Error) {
      stream.markdown(`\n\n⚠️ 응답 생성 실패: ${e.message}`);
    } else {
      throw e;
    }
  }
};

export function activate(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('symbol-event');
  context.subscriptions.push(participant);
}

export function deactivate(): void {
  // ChatParticipant는 subscriptions로 자동 dispose
}
