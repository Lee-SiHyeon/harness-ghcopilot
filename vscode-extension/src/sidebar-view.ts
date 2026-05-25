import * as vscode from 'vscode';
import * as fs from 'fs';
import { HarnessPaths } from './state/paths';
import { loadActionItems, ActionItem } from './state/action-items';
import { getGateState, getTestEvidence, isEvidenceValid } from './state/test-gate';
import { envPathFor, getEnvValue } from './env-file';

const KNOWN_AGENTS = new Set([
  'Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic',
  'Documenter', 'Investigator', 'Scout', 'Release',
  'Context7 Docs Agent', 'Maestro',
]);

interface FlowEvent {
  event?: string;
  agentName?: string | null;
  sessionId?: string | null;
  ts?: string;
  startTs?: string;
  stopTs?: string;
  durationMs?: number | null;
  correlationId?: string;
  skipped?: boolean;
  error?: string;
}

interface SessionSnapshot {
  sessionId: string;
  startTs: string;
  inProgress: Map<string, FlowEvent>; // agentName → Start event
  completed: FlowEvent[];               // Stop events
}

interface RetroEntry {
  date?: string;
  title?: string;
  type?: string;
  pipeline?: string;
  selfCritique?: string;
  ts?: string;
}

interface PipelineEntry {
  step?: string;
  output?: string;
  ts?: string;
  extra?: Record<string, unknown>;
}

interface TodoEntry {
  title?: string;
  status?: string;
}

/** Maestro 사이드바에 띄울 노드. */
export class MaestroTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly section: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children?: MaestroTreeItem[],
    options?: {
      description?: string;
      tooltip?: string;
      iconId?: string;
      contextValue?: string;
      command?: vscode.Command;
    },
  ) {
    super(label, collapsibleState);
    if (options?.description !== undefined) this.description = options.description;
    if (options?.tooltip !== undefined) this.tooltip = options.tooltip;
    if (options?.iconId) this.iconPath = new vscode.ThemeIcon(options.iconId);
    if (options?.contextValue) this.contextValue = options.contextValue;
    if (options?.command) this.command = options.command;
  }
}

export class MaestroTreeProvider implements vscode.TreeDataProvider<MaestroTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<MaestroTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private getHarnessPath: () => string | null;

  constructor(getHarnessPath: () => string | null) {
    this.getHarnessPath = getHarnessPath;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(item: MaestroTreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: MaestroTreeItem): MaestroTreeItem[] {
    if (item && item.children) return item.children;
    if (item) return [];
    return this.buildRoot();
  }

  private buildRoot(): MaestroTreeItem[] {
    const harnessPath = this.getHarnessPath();
    if (!harnessPath) {
      return [new MaestroTreeItem(
        'harness 미발견',
        'error',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          description: 'maestroChat.harnessPath 설정 필요',
          iconId: 'warning',
          tooltip: '워크스페이스에 .github 폴더가 없으면 설정에 절대 경로를 적으세요.',
        },
      )];
    }
    const paths = new HarnessPaths(harnessPath);
    return [
      this.buildPatNode(harnessPath),
      this.buildMigrationNode(),
      this.buildSessionNode(paths),
      this.buildTestGateNode(paths),
      this.buildTodosNode(paths),
      this.buildToolCallsNode(paths),
      this.buildActionItemsNode(paths),
      this.buildRetroNode(paths),
    ];
  }

  private buildMigrationNode(): MaestroTreeItem {
    const cfg = vscode.workspace.getConfiguration('maestroChat');
    const useLegacyRouter = cfg.get<boolean>('useLegacyRouter', false);
    const legacyMcp = cfg.get<boolean>('legacyMcpEnabled', false);
    const children = [
      new MaestroTreeItem(
        useLegacyRouter ? 'Router: legacy hook child_process' : 'Router: extension TS',
        'migration-router',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        { iconId: useLegacyRouter ? 'warning' : 'pass' },
      ),
      new MaestroTreeItem(
        legacyMcp ? 'MCP: legacy 병행' : 'MCP: optional / 미사용',
        'migration-mcp',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        { iconId: legacyMcp ? 'warning' : 'pass' },
      ),
    ];
    return new MaestroTreeItem(
      '마이그레이션 상태',
      'migration',
      vscode.TreeItemCollapsibleState.Expanded,
      children,
      { iconId: 'git-compare', description: useLegacyRouter || legacyMcp ? 'legacy 병행' : 'extension primary' },
    );
  }

  // ── PAT 상태 ───────────────────────────────────────────────────
  private buildPatNode(harnessPath: string): MaestroTreeItem {
    const envPath = envPathFor(harnessPath);
    const value = getEnvValue(envPath, 'GITHUB_PAT');
    const set = !!value && value.length > 0;
    const label = set ? 'GITHUB_PAT — 설정됨' : 'GITHUB_PAT — 미설정';
    return new MaestroTreeItem(
      label,
      'pat',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: set ? 'pass' : 'warning',
        description: set ? maskedPat(value!) : `gpt-4o-mini 분류 비활성 (.env: ${envPath})`,
        tooltip: set
          ? `${envPath} 에 GITHUB_PAT가 설정돼 있습니다. 클릭으로 변경.`
          : `${envPath} 에 GITHUB_PAT가 없습니다. 클릭으로 설정.`,
        contextValue: set ? 'pat-set' : 'pat-unset',
        command: {
          command: 'maestroChat.setGithubPat',
          title: 'Set GITHUB_PAT',
        },
      },
    );
  }

  // ── 현재 세션 ──────────────────────────────────────────────────
  private buildSessionNode(paths: HarnessPaths): MaestroTreeItem {
    const flows = readFlowEvents(paths.log('subagent-flow.jsonl'));
    const session = currentSession(flows);

    if (!session) {
      return new MaestroTreeItem(
        '현재 세션',
        'session',
        vscode.TreeItemCollapsibleState.Expanded,
        [new MaestroTreeItem(
          '(아직 활성 세션 없음)',
          'session-empty',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          { iconId: 'circle-outline' },
        )],
        { iconId: 'pulse' },
      );
    }

    const children: MaestroTreeItem[] = [];
    children.push(new MaestroTreeItem(
      `sessionId: ${session.sessionId.slice(0, 12)}…`,
      'session-meta',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      { iconId: 'symbol-misc', tooltip: session.sessionId },
    ));
    children.push(new MaestroTreeItem(
      `시작: ${formatTime(session.startTs)}`,
      'session-meta',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      { iconId: 'clock' },
    ));

    if (session.inProgress.size > 0) {
      for (const [agent, evt] of session.inProgress) {
        const elapsed = evt.startTs ? Date.now() - new Date(evt.startTs).getTime() : 0;
        children.push(new MaestroTreeItem(
          agent,
          'agent-active',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          {
            iconId: 'sync~spin',
            description: `진행 중 (${formatDuration(elapsed)})`,
          },
        ));
      }
    }

    if (session.completed.length > 0) {
      const recent = session.completed.slice(-10).reverse();
      for (const evt of recent) {
        const agent = evt.agentName || '?';
        const dur = evt.durationMs ? formatDuration(evt.durationMs) : '-';
        const iconId = evt.error ? 'error' : (evt.skipped ? 'circle-slash' : 'pass');
        children.push(new MaestroTreeItem(
          agent,
          'agent-done',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          {
            iconId,
            description: evt.error ? `실패 (${dur})` : (evt.skipped ? `스킵 (${dur})` : `완료 (${dur})`),
            tooltip: evt.error || (evt.skipped ? 'agent .md 파일 없음 등' : ''),
          },
        ));
      }
    }

    return new MaestroTreeItem(
      '현재 세션',
      'session',
      vscode.TreeItemCollapsibleState.Expanded,
      children,
      {
        iconId: 'pulse',
        description: `${session.inProgress.size}개 진행 중 / ${session.completed.length}개 완료`,
      },
    );
  }

  // ── 미해결 actionItems ─────────────────────────────────────────
  private buildActionItemsNode(paths: HarnessPaths): MaestroTreeItem {
    const items = loadActionItems(paths);
    if (items.length === 0) {
      return new MaestroTreeItem(
        '미해결 개선 항목',
        'actions',
        vscode.TreeItemCollapsibleState.Collapsed,
        [new MaestroTreeItem(
          '(없음)',
          'actions-empty',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          { iconId: 'check' },
        )],
        { iconId: 'list-tree', description: '0건' },
      );
    }
    const children = items.map((item: ActionItem, idx: number) => new MaestroTreeItem(
      item.message || `(message 없음 #${idx + 1})`,
      'action-item',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: 'warning',
        description: `${item.source || '?'} / ${item.agent || '?'}`,
        tooltip: JSON.stringify(item, null, 2),
        contextValue: 'action-item',
      },
    ));
    return new MaestroTreeItem(
      '미해결 개선 항목',
      'actions',
      vscode.TreeItemCollapsibleState.Expanded,
      children,
      { iconId: 'list-tree', description: `${items.length}건` },
    );
  }

  private buildTestGateNode(paths: HarnessPaths): MaestroTreeItem {
    const gate = getGateState(paths);
    const evidence = getTestEvidence(paths);
    const valid = isEvidenceValid(paths);
    const children: MaestroTreeItem[] = [];
    children.push(new MaestroTreeItem(
      gate.requiredSince ? `requiredSince: ${formatTime(gate.requiredSince)}` : 'requiredSince: 없음',
      'test-gate-meta',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      { iconId: gate.requiredSince ? 'warning' : 'pass' },
    ));
    children.push(new MaestroTreeItem(
      evidence.ts ? `last evidence: ${evidence.status || evidence.result || '?'} @ ${formatTime(evidence.ts)}` : 'last evidence: 없음',
      'test-gate-evidence',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: valid ? 'pass' : 'error',
        tooltip: evidence.evidence || '(증거 없음)',
        command: { command: 'maestroChat.runExtensionTests', title: 'Run Extension Tests' },
      },
    ));
    return new MaestroTreeItem(
      'Test Gate',
      'test-gate',
      vscode.TreeItemCollapsibleState.Expanded,
      children,
      {
        iconId: valid ? 'pass' : (gate.requiredSince ? 'error' : 'beaker'),
        description: valid ? 'PASS 유효' : (gate.requiredSince ? 'PASS 필요' : '대기'),
      },
    );
  }

  private buildToolCallsNode(paths: HarnessPaths): MaestroTreeItem {
    const entries = readPipeline(paths.log('pipeline.jsonl'))
      .filter(e => typeof e.step === 'string' && e.step.startsWith('tool:'))
      .slice(-10)
      .reverse();
    if (entries.length === 0) {
      return new MaestroTreeItem(
        '최근 Tool Calls',
        'tools',
        vscode.TreeItemCollapsibleState.Collapsed,
        [new MaestroTreeItem('(없음)', 'tools-empty', vscode.TreeItemCollapsibleState.None, undefined, { iconId: 'circle-outline' })],
        { iconId: 'tools' },
      );
    }
    const children = entries.map(e => new MaestroTreeItem(
      e.step || '(tool)',
      'tool-call',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: e.extra?.exitCode === 0 ? 'pass' : 'tools',
        description: e.extra?.command ? String(e.extra.command).slice(0, 40) : (e.extra?.path ? String(e.extra.path) : ''),
        tooltip: JSON.stringify(e, null, 2),
      },
    ));
    return new MaestroTreeItem(
      '최근 Tool Calls',
      'tools',
      vscode.TreeItemCollapsibleState.Collapsed,
      children,
      { iconId: 'tools', description: `${entries.length}건` },
    );
  }

  private buildTodosNode(paths: HarnessPaths): MaestroTreeItem {
    const todos = readTodos(paths.log('current-todos.json'));
    if (todos.length === 0) {
      return new MaestroTreeItem(
        'Todo 상태',
        'todos',
        vscode.TreeItemCollapsibleState.Collapsed,
        [new MaestroTreeItem('(없음)', 'todos-empty', vscode.TreeItemCollapsibleState.None, undefined, { iconId: 'circle-outline' })],
        { iconId: 'checklist' },
      );
    }
    const done = todos.filter(t => t.status === 'completed').length;
    const children = todos.slice(0, 20).map(t => new MaestroTreeItem(
      t.title || '(title 없음)',
      'todo-item',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: t.status === 'completed' ? 'pass' : (t.status === 'in-progress' ? 'sync~spin' : 'circle-outline'),
        description: t.status || '?',
      },
    ));
    return new MaestroTreeItem(
      'Todo 상태',
      'todos',
      vscode.TreeItemCollapsibleState.Collapsed,
      children,
      { iconId: 'checklist', description: `${done}/${todos.length}` },
    );
  }

  // ── 최근 회고 5건 ──────────────────────────────────────────────
  private buildRetroNode(paths: HarnessPaths): MaestroTreeItem {
    const entries = readRetro(paths.log('retro.jsonl')).slice(-5).reverse();
    if (entries.length === 0) {
      return new MaestroTreeItem(
        '최근 회고',
        'retro',
        vscode.TreeItemCollapsibleState.Collapsed,
        [new MaestroTreeItem(
          '(아직 회고 없음)',
          'retro-empty',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          { iconId: 'circle-outline' },
        )],
        { iconId: 'book' },
      );
    }
    const children = entries.map(entry => new MaestroTreeItem(
      entry.title || '(제목 없음)',
      'retro-entry',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: 'book',
        description: `${entry.date || '?'} / ${entry.type || '?'}`,
        tooltip: entry.selfCritique || '(자기비평 없음)',
      },
    ));
    return new MaestroTreeItem(
      '최근 회고',
      'retro',
      vscode.TreeItemCollapsibleState.Collapsed,
      children,
      { iconId: 'book', description: `최근 ${entries.length}건` },
    );
  }
}

// ── 헬퍼들 ───────────────────────────────────────────────────────

function readFlowEvents(filePath: string): FlowEvent[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out: FlowEvent[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

function readRetro(filePath: string): RetroEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out: RetroEntry[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

function readPipeline(filePath: string): PipelineEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out: PipelineEntry[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

function readTodos(filePath: string): TodoEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw.todos) ? raw.todos : [];
  } catch {
    return [];
  }
}

function currentSession(events: FlowEvent[]): SessionSnapshot | null {
  // 가장 최근 MaestroSessionStart를 기준으로 세션 묶음 구성
  let sessionId = '';
  let startTs = '';
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'MaestroSessionStart' && events[i].sessionId) {
      sessionId = String(events[i].sessionId);
      startTs = String(events[i].ts || '');
      break;
    }
  }
  if (!sessionId) {
    // Fallback: 가장 최근 sessionId 사용
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].sessionId) {
        sessionId = String(events[i].sessionId);
        startTs = String(events[i].ts || events[i].startTs || '');
        break;
      }
    }
    if (!sessionId) return null;
  }

  const inProgress = new Map<string, FlowEvent>();
  const completed: FlowEvent[] = [];
  for (const evt of events) {
    if (evt.sessionId !== sessionId) continue;
    const name = evt.agentName || '';
    if (!KNOWN_AGENTS.has(name)) continue;
    if (evt.event === 'SubagentStart') {
      inProgress.set(name, evt);
    } else if (evt.event === 'SubagentStop') {
      inProgress.delete(name);
      completed.push(evt);
    }
  }
  return { sessionId, startTs, inProgress, completed };
}

function maskedPat(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '…' + value.slice(-4);
}

function formatTime(iso: string): string {
  if (!iso) return '?';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
