import * as vscode from 'vscode';
import * as fs from 'fs';
import { HarnessPaths } from './state/paths';
import { loadActionItems, ActionItem } from './state/action-items';
import { getGateState, getTestEvidence, isEvidenceValid } from './state/test-gate';
import { envPathFor, getEnvValue } from './env-file';
import { inspectMcpStatus } from './mcp-status';
import { getRuntimeSnapshot, RuntimeModelInfo } from './runtime-state';
import { listAgents } from './agents/loader';

const KNOWN_AGENTS = new Set([
  'Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic',
  'Documenter', 'Investigator', 'Inspector', 'Scout', 'Release',
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
  source?: string;
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
      this.buildRuntimeNode(),
      this.buildMigrationNode(),
      this.buildMcpNode(harnessPath),
      this.buildAgentsNode(paths),
      this.buildSessionNode(paths),
      this.buildSubagentFlowNode(paths),
      this.buildTestGateNode(paths),
      this.buildTodosNode(paths),
      this.buildToolCallsNode(paths),
      this.buildActionItemsNode(paths),
      this.buildRetroNode(paths),
    ];
  }

  private buildRuntimeNode(): MaestroTreeItem {
    const runtime = getRuntimeSnapshot();
    const children: MaestroTreeItem[] = [];
    children.push(new MaestroTreeItem(
      runtime.chatUiModel ? `Chat UI: ${formatModel(runtime.chatUiModel)}` : 'Chat UI 모델: 아직 요청 없음',
      'runtime-model-chat',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: runtime.chatUiModel ? 'symbol-method' : 'circle-outline',
        tooltip: runtime.chatUiModel ? JSON.stringify(runtime.chatUiModel, null, 2) : 'ChatRequest.model에서 읽은 현재 UI 선택 모델입니다.',
      },
    ));
    children.push(new MaestroTreeItem(
      runtime.selectedModel
        ? `Maestro 사용: ${formatModel(runtime.selectedModel)}`
        : runtime.selectedModelSource === 'local-direct-no-llm'
          ? 'Maestro 사용: 로컬 응답 (LLM 미호출)'
          : 'Maestro 사용: 아직 LLM 미선택',
      'runtime-model-selected',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: runtime.selectedModel ? 'pass' : (runtime.selectedModelSource === 'local-direct-no-llm' ? 'zap' : 'circle-outline'),
        description: runtime.selectedModelSource || '',
        tooltip: runtime.selectedModel
          ? JSON.stringify(runtime.selectedModel, null, 2)
          : '짧은 상태/도움말 요청은 크레딧을 쓰지 않고 로컬에서 답할 수 있습니다.',
      },
    ));
    children.push(new MaestroTreeItem(
      `모드: ${runtime.executorMode || '?'}`,
      'runtime-executor',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      { iconId: 'settings-gear' },
    ));
    children.push(new MaestroTreeItem(
      `intent: ${runtime.intent || '?'} / pipeline: ${(runtime.pipeline || []).join(' -> ') || '직접 답변'}`,
      'runtime-router',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: 'list-tree',
        tooltip: `promptChars=${runtime.promptChars ?? '?'}\nupdated=${runtime.updatedAt || '?'}`,
      },
    ));

    const auth = runtime.githubAuth;
    children.push(new MaestroTreeItem(
      auth?.hasSession
        ? `VS Code GitHub: ${auth.accountLabel || '(label 없음)'}`
        : auth?.accountLabel
          ? `VS Code GitHub: ${auth.accountLabel} (권한 미승인)`
          : 'VS Code GitHub: 세션 없음',
      'runtime-account',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: auth?.hasSession ? 'github' : 'account',
        description: auth?.accountCount !== undefined ? `${auth.accountCount} account(s)` : '',
        tooltip: auth?.error
          ? auth.error
          : 'VS Code authentication API의 github 세션입니다. Copilot 결제/조직 allowance 자체는 VS Code 공개 API가 직접 노출하지 않습니다.',
      },
    ));

    const description = runtime.selectedModel
      ? runtime.selectedModel.name
      : runtime.selectedModelSource === 'local-direct-no-llm'
        ? 'local'
        : '대기';
    return new MaestroTreeItem(
      '런타임 연결 상태',
      'runtime',
      vscode.TreeItemCollapsibleState.Expanded,
      children,
      { iconId: 'radio-tower', description },
    );
  }

  private buildAgentsNode(paths: HarnessPaths): MaestroTreeItem {
    const agents = listAgents(paths);
    if (agents.length === 0) {
      return new MaestroTreeItem(
        'Agent Catalog',
        'agents',
        vscode.TreeItemCollapsibleState.Collapsed,
        [new MaestroTreeItem('(agents/*.agent.md 없음)', 'agents-empty', vscode.TreeItemCollapsibleState.None, undefined, { iconId: 'warning' })],
        { iconId: 'person', description: '0' },
      );
    }

    const reviewerAgents = agents.filter(agent => /reviewer/i.test(agent.fileName || agent.name));
    const coreAgents = agents.filter(agent => !reviewerAgents.includes(agent));
    const makeLeaf = (agent: ReturnType<typeof listAgents>[number]) => new MaestroTreeItem(
      `@${agent.name}`,
      'agent-leaf',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: agent.userInvocable ? 'person' : 'eye-closed',
        description: [
          agent.delegatedAgents.length ? `delegates ${agent.delegatedAgents.length}` : '',
          agent.toolPreferences.length ? `tools ${agent.toolPreferences.length}` : '',
        ].filter(Boolean).join(' / '),
        tooltip: [
          agent.description || '(description 없음)',
          agent.modelPreferences.length ? `models: ${agent.modelPreferences.join(', ')}` : '',
          agent.toolPreferences.length ? `tools: ${agent.toolPreferences.join(', ')}` : '',
          agent.delegatedAgents.length ? `agents: ${agent.delegatedAgents.join(', ')}` : '',
          `user-invocable: ${agent.userInvocable}`,
        ].filter(Boolean).join('\n'),
        command: agent.fileName
          ? { command: 'vscode.open', title: 'Open Agent Definition', arguments: [vscode.Uri.file(paths.agent(agent.fileName))] }
          : undefined,
      },
    );

    const children: MaestroTreeItem[] = [];
    if (coreAgents.length > 0) {
      children.push(new MaestroTreeItem(
        'Core Agents',
        'agent-category',
        vscode.TreeItemCollapsibleState.Expanded,
        coreAgents.map(makeLeaf),
        { iconId: 'folder', description: `${coreAgents.length}` },
      ));
    }
    if (reviewerAgents.length > 0) {
      children.push(new MaestroTreeItem(
        'Language Reviewers',
        'agent-category',
        vscode.TreeItemCollapsibleState.Collapsed,
        reviewerAgents.map(makeLeaf),
        { iconId: 'folder', description: `${reviewerAgents.length}` },
      ));
    }

    const delegating = agents.filter(agent => agent.delegatedAgents.length > 0).length;
    return new MaestroTreeItem(
      'Agent Catalog',
      'agents',
      vscode.TreeItemCollapsibleState.Collapsed,
      children,
      { iconId: 'person', description: `${agents.length} / delegates ${delegating}` },
    );
  }

  private buildMigrationNode(): MaestroTreeItem {
    const cfg = vscode.workspace.getConfiguration('maestroChat');
    const useLegacyRouter = cfg.get<boolean>('useLegacyRouter', false);
    const useLlmRouter = cfg.get<boolean>('useLlmRouter', true);
    const legacyMcp = cfg.get<boolean>('legacyMcpEnabled', false);
    const children = [
      new MaestroTreeItem(
        useLegacyRouter
          ? 'Router: legacy hook child_process'
          : useLlmRouter
            ? 'Router: GitHub Models LLM -> extension TS fallback'
            : 'Router: extension TS only',
        'migration-router',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          iconId: useLegacyRouter ? 'warning' : 'pass',
          tooltip: useLegacyRouter
            ? 'hooks/scripts/maestro-router.js를 child_process로 호출합니다.'
            : useLlmRouter
              ? 'GITHUB_PAT가 있으면 extension 내부에서 GitHub Models gpt-4o-mini 분류를 먼저 시도합니다.'
              : 'GITHUB_PAT가 있어도 분류에는 쓰지 않고 deterministic TS router만 사용합니다.',
        },
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

  private buildMcpNode(harnessPath: string): MaestroTreeItem {
    const status = inspectMcpStatus(harnessPath);
    const ok = status.registered && status.distExists && status.pointsToHarness;
    const shared = status.sharedState;
    const stateCount = Object.values(shared).filter(Boolean).length;
    const children: MaestroTreeItem[] = [
      new MaestroTreeItem(
        status.registered ? 'github-state 등록됨' : 'github-state 미등록',
        'mcp-registered',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          iconId: status.registered ? 'pass' : 'warning',
          description: status.configPath || 'mcp.json 없음',
          tooltip: status.configPath || 'VS Code/User/mcp.json에서 github-state를 찾지 못했습니다.',
        },
      ),
      new MaestroTreeItem(
        status.distExists ? 'dist/index.js 있음' : 'dist/index.js 없음',
        'mcp-dist',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        { iconId: status.distExists ? 'pass' : 'error' },
      ),
      new MaestroTreeItem(
        status.pointsToHarness ? '현재 harness를 가리킴' : '다른 harness 또는 미등록',
        'mcp-target',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          iconId: status.pointsToHarness ? 'pass' : 'warning',
          tooltip: (status.args || []).join(' '),
        },
      ),
      new MaestroTreeItem(
        `도구 ${status.toolNames.length}개`,
        'mcp-tools',
        vscode.TreeItemCollapsibleState.Collapsed,
        status.toolNames.map(name => new MaestroTreeItem(
          name,
          'mcp-tool',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          { iconId: 'symbol-method' },
        )),
        { iconId: 'tools' },
      ),
      new MaestroTreeItem(
        `공유 상태 파일 ${stateCount}/6`,
        'mcp-shared-state',
        vscode.TreeItemCollapsibleState.Collapsed,
        Object.entries(shared).map(([name, exists]) => new MaestroTreeItem(
          name,
          'mcp-state-file',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          { iconId: exists ? 'pass' : 'circle-outline' },
        )),
        { iconId: stateCount === 6 ? 'pass' : 'database' },
      ),
    ];
    return new MaestroTreeItem(
      'MCP github-state',
      'mcp',
      vscode.TreeItemCollapsibleState.Collapsed,
      children,
      {
        iconId: ok ? 'plug' : 'warning',
        description: ok ? 'ready' : '확인 필요',
      },
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

  private buildSubagentFlowNode(paths: HarnessPaths): MaestroTreeItem {
    const flows = readFlowEvents(paths.log('subagent-flow.jsonl'));
    const session = currentSession(flows);
    if (!session) {
      return new MaestroTreeItem(
        'Subagent 호출 흐름',
        'flow',
        vscode.TreeItemCollapsibleState.Collapsed,
        [new MaestroTreeItem('(아직 호출 없음)', 'flow-empty', vscode.TreeItemCollapsibleState.None, undefined, { iconId: 'circle-outline' })],
        { iconId: 'type-hierarchy' },
      );
    }

    const sessionFlows = flows
      .filter(evt => evt.sessionId === session.sessionId && evt.agentName && KNOWN_AGENTS.has(evt.agentName))
      .slice(-30);
    const children = sessionFlows.map(evt => {
      const isStart = evt.event === 'SubagentStart';
      const isStop = evt.event === 'SubagentStop';
      const label = `${isStart ? 'Start' : isStop ? 'Stop' : evt.event || '?'}: ${evt.agentName || '?'}`;
      const description = isStop && evt.durationMs !== undefined && evt.durationMs !== null
        ? formatDuration(evt.durationMs)
        : evt.source || '';
      return new MaestroTreeItem(
        label,
        'flow-event',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          iconId: evt.error ? 'error' : (isStart ? 'debug-start' : 'debug-stop'),
          description,
          tooltip: JSON.stringify(evt, null, 2),
        },
      );
    });

    return new MaestroTreeItem(
      'Subagent 호출 흐름',
      'flow',
      vscode.TreeItemCollapsibleState.Collapsed,
      children,
      { iconId: 'type-hierarchy', description: `${children.length} events` },
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

function formatModel(model: RuntimeModelInfo): string {
  return `${model.name} (${model.family || model.vendor})`;
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
