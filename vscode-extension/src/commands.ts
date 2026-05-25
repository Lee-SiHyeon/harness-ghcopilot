import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { envPathFor, getEnvValue, setEnvValue, clearEnvValue } from './env-file';
import { HarnessPaths } from './state/paths';
import { clearActionItems } from './state/action-items';
import { determineTestResult, recordTestEvidence } from './state/test-gate';
import { mcpConfigCandidates } from './mcp-status';

type HarnessResolver = () => string | null;
type RefreshFn = () => void;

const PAT_PLACEHOLDER = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

/** Maestro: Set GITHUB_PAT — InputBox로 받아 .env에 기록. */
async function cmdSetGithubPat(resolver: HarnessResolver, refresh: RefreshFn): Promise<void> {
  const harnessPath = resolver();
  if (!harnessPath) {
    vscode.window.showErrorMessage(
      'Maestro harness(.github)를 찾을 수 없습니다. 워크스페이스를 열거나 maestroChat.harnessPath 설정을 확인하세요.',
    );
    return;
  }
  const envPath = envPathFor(harnessPath);
  const current = getEnvValue(envPath, 'GITHUB_PAT');
  const masked = current ? current.slice(0, 4) + '…' + current.slice(-4) : '(미설정)';

  const value = await vscode.window.showInputBox({
    title: `GITHUB_PAT 설정 — ${envPath}`,
    prompt: `현재: ${masked}. 새 PAT를 입력하세요 (ghp_... 또는 비워서 취소).`,
    password: true,
    placeHolder: PAT_PLACEHOLDER,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v) return null; // empty → cancel
      if (v.length < 20) return 'PAT가 너무 짧습니다 (보통 ghp_...로 시작하는 36자 이상).';
      if (/\s/.test(v)) return '공백이 포함돼서는 안 됩니다.';
      return null;
    },
  });
  if (!value) return; // cancelled

  try {
    const result = setEnvValue(envPath, 'GITHUB_PAT', value);
    vscode.window.showInformationMessage(
      result.keyExisted
        ? `GITHUB_PAT 갱신됨 (${envPath})`
        : `GITHUB_PAT 신규 추가됨 (${envPath})`,
    );
    refresh();
  } catch (e) {
    vscode.window.showErrorMessage(`GITHUB_PAT 저장 실패: ${(e as Error).message}`);
  }
}

/** Maestro: Clear GITHUB_PAT — 확인 후 .env에서 GITHUB_PAT 라인 제거. */
async function cmdClearGithubPat(resolver: HarnessResolver, refresh: RefreshFn): Promise<void> {
  const harnessPath = resolver();
  if (!harnessPath) {
    vscode.window.showErrorMessage('Maestro harness(.github)를 찾을 수 없습니다.');
    return;
  }
  const envPath = envPathFor(harnessPath);
  const current = getEnvValue(envPath, 'GITHUB_PAT');
  if (!current) {
    vscode.window.showInformationMessage('GITHUB_PAT는 이미 미설정 상태입니다.');
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `${envPath} 의 GITHUB_PAT를 제거할까요? 분류기가 regex 폴백으로 전환됩니다.`,
    { modal: true },
    '제거',
  );
  if (pick !== '제거') return;
  try {
    clearEnvValue(envPath, 'GITHUB_PAT');
    vscode.window.showInformationMessage(`GITHUB_PAT 제거됨 (${envPath})`);
    refresh();
  } catch (e) {
    vscode.window.showErrorMessage(`GITHUB_PAT 제거 실패: ${(e as Error).message}`);
  }
}

/** Maestro: Open .env — 파일이 없으면 생성하고 연다. */
async function cmdOpenEnvFile(resolver: HarnessResolver): Promise<void> {
  const harnessPath = resolver();
  if (!harnessPath) {
    vscode.window.showErrorMessage('Maestro harness(.github)를 찾을 수 없습니다.');
    return;
  }
  const envPath = envPathFor(harnessPath);
  const fs = await import('fs');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, '# Maestro Chat — .env\n# GITHUB_PAT=ghp_...\n', 'utf8');
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(envPath));
  await vscode.window.showTextDocument(doc);
}

/** Maestro: Open Harness Folder — 탐색기에서 harness 폴더 노출. */
async function cmdOpenHarness(resolver: HarnessResolver): Promise<void> {
  const harnessPath = resolver();
  if (!harnessPath) {
    vscode.window.showErrorMessage('Maestro harness(.github)를 찾을 수 없습니다.');
    return;
  }
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(harnessPath));
}

/** Maestro: Open Logs Folder — logs 디렉토리 탐색기에서 노출. */
async function cmdOpenLogs(resolver: HarnessResolver): Promise<void> {
  const harnessPath = resolver();
  if (!harnessPath) {
    vscode.window.showErrorMessage('Maestro harness(.github)를 찾을 수 없습니다.');
    return;
  }
  const logs = new HarnessPaths(harnessPath).logsDir;
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logs));
}

async function cmdOpenMcpConfig(): Promise<void> {
  const fs = await import('fs');
  const candidates = mcpConfigCandidates();
  let target = candidates.find(p => fs.existsSync(p));
  if (!target) {
    target = candidates[0];
    if (!target) {
      vscode.window.showErrorMessage('MCP config 후보 경로를 계산하지 못했습니다.');
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{\n  "servers": {}\n}\n', 'utf8');
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  await vscode.window.showTextDocument(doc);
}

async function cmdClearActionItems(resolver: HarnessResolver, refresh: RefreshFn): Promise<void> {
  const harnessPath = resolver();
  if (!harnessPath) {
    vscode.window.showErrorMessage('Maestro harness(.github)를 찾을 수 없습니다.');
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    'retrospective-draft.json의 actionItems를 비울까요?',
    { modal: true },
    '초기화',
  );
  if (pick !== '초기화') return;
  clearActionItems(new HarnessPaths(harnessPath));
  refresh();
}

async function cmdRunExtensionTests(resolver: HarnessResolver, refresh: RefreshFn): Promise<void> {
  const harnessPath = resolver();
  if (!harnessPath) {
    vscode.window.showErrorMessage('Maestro harness(.github)를 찾을 수 없습니다.');
    return;
  }
  const paths = new HarnessPaths(harnessPath);
  const cwd = path.join(harnessPath, 'vscode-extension');
  const output = vscode.window.createOutputChannel('Maestro Test Run');
  output.show(true);
  output.appendLine(`[Maestro] npm test 시작: ${cwd}`);
  exec('npm test', { cwd, timeout: 180_000, windowsHide: true }, (err, stdout, stderr) => {
    const exitCode = typeof (err as NodeJS.ErrnoException | null)?.code === 'number'
      ? Number((err as NodeJS.ErrnoException).code)
      : (err ? 1 : 0);
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    output.appendLine(combined || '(empty output)');
    const result = determineTestResult(exitCode, combined);
    recordTestEvidence(paths, {
      command: 'npm test',
      result,
      status: result,
      exitCode,
      evidence: combined.split(/\r?\n/).slice(-80).join('\n'),
    });
    refresh();
    const msg = `Maestro extension tests: ${result} (exitCode=${exitCode})`;
    if (result === 'PASS') vscode.window.showInformationMessage(msg);
    else vscode.window.showErrorMessage(msg);
  });
}

export function registerCommands(
  context: vscode.ExtensionContext,
  resolver: HarnessResolver,
  refresh: RefreshFn,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('maestroChat.setGithubPat',   () => cmdSetGithubPat(resolver, refresh)),
    vscode.commands.registerCommand('maestroChat.clearGithubPat', () => cmdClearGithubPat(resolver, refresh)),
    vscode.commands.registerCommand('maestroChat.openEnvFile',    () => cmdOpenEnvFile(resolver)),
    vscode.commands.registerCommand('maestroChat.openHarness',    () => cmdOpenHarness(resolver)),
    vscode.commands.registerCommand('maestroChat.openLogs',       () => cmdOpenLogs(resolver)),
    vscode.commands.registerCommand('maestroChat.openMcpConfig',  () => cmdOpenMcpConfig()),
    vscode.commands.registerCommand('maestroChat.clearActionItems', () => cmdClearActionItems(resolver, refresh)),
    vscode.commands.registerCommand('maestroChat.runExtensionTests', () => cmdRunExtensionTests(resolver, refresh)),
    vscode.commands.registerCommand('maestroChat.refresh',        () => refresh()),
  );
}
