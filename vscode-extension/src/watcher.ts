import * as fs from 'fs';
import * as path from 'path';

type RefreshFn = () => void;

/**
 * 사이드바 자동 refresh를 위한 fs.watch 기반 감시자.
 * vscode.workspace.createFileSystemWatcher는 workspace 안 파일만 지원하므로
 * harness가 외부에 있을 수도 있는 우리 케이스에서는 Node의 fs.watch를 사용.
 *
 * debounce 500ms — 동시 이벤트가 폭주해도 한 번만 refresh.
 */
const DEBOUNCE_MS = 500;

const WATCHED_FILES = [
  'subagent-flow.jsonl',
  'retrospective-draft.json',
  'retro.jsonl',
];

export class HarnessWatcher {
  private currentHarness: string | null = null;
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly refresh: RefreshFn;

  constructor(refresh: RefreshFn) {
    this.refresh = refresh;
  }

  watch(harnessPath: string | null): void {
    if (this.currentHarness === harnessPath) return;
    this.dispose();
    this.currentHarness = harnessPath;
    if (!harnessPath) return;

    const logsDir = path.join(harnessPath, 'logs');
    if (!fs.existsSync(logsDir)) {
      try { fs.mkdirSync(logsDir, { recursive: true }); } catch { /* noop */ }
    }

    for (const filename of WATCHED_FILES) {
      const target = path.join(logsDir, filename);
      try {
        // 파일이 없을 수 있으니 dir-watch로 한다 (생성 이벤트도 잡음).
        // 이미 logsDir 전체에 대한 watcher 하나면 충분.
        // 같은 dir에 여러 번 다는 건 피함.
        if (this.watchers.length > 0) break;
        const w = fs.watch(logsDir, { persistent: false }, (_event, changedName) => {
          if (!changedName) return;
          if (!WATCHED_FILES.includes(String(changedName))) return;
          this.scheduleRefresh();
        });
        this.watchers.push(w);
      } catch {
        /* watch 실패하면 manual refresh에 의존 */
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      try { this.refresh(); } catch { /* noop */ }
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const w of this.watchers) {
      try { w.close(); } catch { /* noop */ }
    }
    this.watchers = [];
    this.currentHarness = null;
  }
}
