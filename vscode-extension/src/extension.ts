import * as vscode from 'vscode';
import { callMaestroRouter, extractBadge } from './router-bridge';

const PARTICIPANT_ID = 'maestro';

function findWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  // .github 하위 디렉토리를 가진 워크스페이스 우선
  for (const f of folders) {
    const fsPath = f.uri.fsPath;
    try {
      // require fs only when needed
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs');
      if (fs.existsSync(`${fsPath}/.github/hooks/scripts/maestro-router.js`)) return fsPath;
    } catch { /* noop */ }
  }
  return folders[0].uri.fsPath;
}

const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
  const workspaceRoot = findWorkspaceRoot();
  if (!workspaceRoot) {
    stream.markdown('⚠️ 워크스페이스가 열려있지 않습니다. `.github/` 폴더가 있는 폴더를 여세요.');
    return;
  }

  // 1) 분류기 호출 — 기존 hook 로직 그대로 재사용
  stream.progress('Maestro router 분류 중…');
  let routerResult;
  try {
    routerResult = await callMaestroRouter(request.prompt, workspaceRoot);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stream.markdown(`⚠️ Maestro router 호출 실패: \`${msg}\``);
    return;
  }

  const userMessage = routerResult.modifiedParameters?.userMessage || request.prompt;
  const badge = extractBadge(userMessage);

  // 2) ★ 배지 강제 출력 — UI에 100% 표시 보장 (LLM 응답과 무관)
  if (badge) {
    stream.markdown('```\n' + badge + '\n```\n\n');
  } else {
    // 라우터가 분류는 했지만 헤더 추출 실패 — 폴백 메시지
    stream.markdown(
      '> ⚠️ Maestro 분류 헤더를 추출하지 못했습니다 (router 출력 형식이 바뀌었거나 단순 패스스루).\n\n'
    );
  }

  // HITL gate: 라우터가 사용자 확인 요청을 한 경우
  if (routerResult.decision === 'ask' && routerResult.reason) {
    stream.markdown('\n---\n\n' + routerResult.reason);
    return;
  }

  // 3) vscode.lm으로 Copilot LLM 호출
  let model: vscode.LanguageModelChat | undefined;
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    model = models[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stream.markdown(`\n\n⚠️ Language Model 선택 실패: \`${msg}\``);
    return;
  }

  if (!model) {
    stream.markdown(
      '\n\n⚠️ Copilot 언어 모델을 찾을 수 없습니다. GitHub Copilot 구독 + Chat 확장 활성화를 확인하세요.'
    );
    return;
  }

  // 4) Maestro userMessage를 LLM에 전달 (배지 + todo 가이드 + 회고 + 원본 요청 포함)
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
