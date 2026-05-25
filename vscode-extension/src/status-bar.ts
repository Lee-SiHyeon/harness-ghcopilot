import * as vscode from 'vscode';
import { envPathFor, getEnvValue } from './env-file';

/**
 * 상태바에 "🎼 Maestro [PAT ✅/⚠️]" 표시.
 * 클릭하면 maestroChat.setGithubPat 명령 실행.
 *
 * harness가 없으면 "🎼 Maestro [harness ?]"로 표시 (클릭 시 설정 열기).
 */
export class MaestroStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(getHarnessPath: () => string | null) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.refresh(getHarnessPath);
  }

  refresh(getHarnessPath: () => string | null): void {
    const harnessPath = getHarnessPath();
    if (!harnessPath) {
      this.item.text = '🎼 Maestro [harness ?]';
      this.item.tooltip = 'Maestro harness(.github)를 찾지 못함. 클릭으로 설정 열기.';
      this.item.command = 'workbench.action.openSettings';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.show();
      return;
    }
    const value = getEnvValue(envPathFor(harnessPath), 'GITHUB_PAT');
    const cfg = vscode.workspace.getConfiguration('maestroChat');
    const useLegacyRouter = cfg.get<boolean>('useLegacyRouter', false);
    const useLlmRouter = cfg.get<boolean>('useLlmRouter', true);
    const routerMode = useLegacyRouter ? 'legacy' : (useLlmRouter ? 'LLM+TS' : 'TS');
    if (value && value.length > 0) {
      this.item.text = `🎼 Maestro [PAT ✅ ${routerMode}]`;
      this.item.tooltip =
        `GITHUB_PAT 설정됨 (${envPathFor(harnessPath)}).\n` +
        (useLegacyRouter
          ? 'legacy hook router가 사용됩니다.'
          : useLlmRouter
            ? 'extension 내부 GitHub Models LLM router를 먼저 시도하고 실패 시 TS router로 폴백합니다.'
            : 'extension TS router만 사용합니다. GITHUB_PAT는 저장되어 있지만 분류에는 쓰지 않습니다.') +
        '\n클릭으로 PAT 변경.';
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `🎼 Maestro [PAT ⚠️ ${routerMode}]`;
      this.item.tooltip =
        `GITHUB_PAT 미설정 — GitHub Models LLM router 비활성, extension TS router 사용.\n` +
        `파일: ${envPathFor(harnessPath)}\n` +
        `클릭으로 설정.`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    this.item.command = 'maestroChat.setGithubPat';
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
