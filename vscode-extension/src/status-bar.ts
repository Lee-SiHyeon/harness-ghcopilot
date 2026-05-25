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
    if (value && value.length > 0) {
      this.item.text = '🎼 Maestro [PAT ✅]';
      this.item.tooltip = `GITHUB_PAT 설정됨 (${envPathFor(harnessPath)}). 클릭으로 변경.`;
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = '🎼 Maestro [PAT ⚠️]';
      this.item.tooltip =
        `GITHUB_PAT 미설정 — gpt-4o-mini 분류기 비활성 (regex 폴백).\n` +
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
