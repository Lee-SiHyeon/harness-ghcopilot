import * as vscode from 'vscode';
import { inspectMcpStatus, McpServerStatus } from './mcp-status';
import { MaestroTreeItem } from './sidebar-view';

export class McpTreeProvider implements vscode.TreeDataProvider<MaestroTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<MaestroTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly getHarnessPath: () => string | null) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(item: MaestroTreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: MaestroTreeItem): MaestroTreeItem[] {
    if (item?.children) return item.children;
    if (item) return [];
    const harness = this.getHarnessPath();
    if (!harness) {
      return [new MaestroTreeItem(
        'harness 미발견',
        'mcp-error',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        { iconId: 'warning', description: 'maestroChat.harnessPath 확인' },
      )];
    }
    return buildMcpRoot(inspectMcpStatus(harness));
  }
}

function buildMcpRoot(status: McpServerStatus): MaestroTreeItem[] {
  const sharedCount = Object.values(status.sharedState).filter(Boolean).length;
  return [
    new MaestroTreeItem(
      status.registered ? 'github-state registered' : 'github-state not registered',
      'mcp-registration',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        iconId: status.registered ? 'pass' : 'warning',
        description: status.configPath || 'mcp.json missing',
        tooltip: status.configPath || '',
        command: { command: 'maestroChat.openMcpConfig', title: 'Open MCP Config' },
      },
    ),
    new MaestroTreeItem(
      status.distExists ? 'server build present' : 'server build missing',
      'mcp-build',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      { iconId: status.distExists ? 'pass' : 'error', description: 'mcp-server/dist/index.js' },
    ),
    new MaestroTreeItem(
      status.pointsToHarness ? 'points to current harness' : 'target mismatch or unregistered',
      'mcp-target',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      { iconId: status.pointsToHarness ? 'pass' : 'warning', tooltip: (status.args || []).join(' ') },
    ),
    new MaestroTreeItem(
      `tools (${status.toolNames.length})`,
      'mcp-tools',
      vscode.TreeItemCollapsibleState.Expanded,
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
      `shared logs (${sharedCount}/6)`,
      'mcp-shared-state',
      vscode.TreeItemCollapsibleState.Expanded,
      Object.entries(status.sharedState).map(([name, exists]) => new MaestroTreeItem(
        name,
        'mcp-state-file',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        { iconId: exists ? 'pass' : 'circle-outline' },
      )),
      { iconId: sharedCount === 6 ? 'pass' : 'database' },
    ),
  ];
}
