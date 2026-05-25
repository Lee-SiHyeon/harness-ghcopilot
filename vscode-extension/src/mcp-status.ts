import * as fs from 'fs';
import * as path from 'path';
import { HarnessPaths } from './state/paths';

export interface McpServerStatus {
  id: string;
  registered: boolean;
  configPath: string | null;
  command?: string;
  args?: string[];
  distExists: boolean;
  packageExists: boolean;
  pointsToHarness: boolean;
  toolNames: string[];
  sharedState: {
    todos: boolean;
    flow: boolean;
    draft: boolean;
    evidence: boolean;
    gate: boolean;
    retro: boolean;
  };
}

export const MCP_TOOL_NAMES = [
  'todo_get',
  'todo_create',
  'todo_update',
  'todo_bulk_update',
  'todo_clear',
  'pipeline_record_start',
  'pipeline_record_stop',
  'pipeline_query',
  'actionitems_get',
  'actionitems_append',
  'actionitems_consume',
  'actionitems_update_draft',
  'testgate_get',
  'testgate_set',
  'testgate_record_evidence',
  'testgate_is_valid',
  'retro_append',
  'retro_get_recent',
  'retro_get_patterns',
];

export function inspectMcpStatus(harnessPath: string): McpServerStatus {
  const paths = new HarnessPaths(harnessPath);
  const configCandidates = mcpConfigCandidates();
  let configPath: string | null = null;
  let server: { command?: string; args?: string[] } | undefined;
  for (const candidate of configCandidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const found = parsed?.servers?.['github-state'];
      if (found) {
        configPath = candidate;
        server = found;
        break;
      }
    } catch {
      /* next */
    }
  }

  const distPath = path.join(harnessPath, 'mcp-server', 'dist', 'index.js');
  const packagePath = path.join(harnessPath, 'mcp-server', 'package.json');
  const args = Array.isArray(server?.args) ? server!.args!.map(String) : [];
  const normalizedHarness = path.resolve(harnessPath).toLowerCase();
  const pointsToHarness = args.some(a => path.resolve(a).toLowerCase().startsWith(normalizedHarness));

  return {
    id: 'github-state',
    registered: !!server,
    configPath,
    command: server?.command,
    args,
    distExists: fs.existsSync(distPath),
    packageExists: fs.existsSync(packagePath),
    pointsToHarness,
    toolNames: MCP_TOOL_NAMES,
    sharedState: {
      todos: fs.existsSync(paths.log('current-todos.json')),
      flow: fs.existsSync(paths.log('subagent-flow.jsonl')),
      draft: fs.existsSync(paths.log('retrospective-draft.json')),
      evidence: fs.existsSync(paths.log('test-evidence.json')),
      gate: fs.existsSync(paths.log('test-gate-state.json')),
      retro: fs.existsSync(paths.log('retro.jsonl')),
    },
  };
}

export function mcpConfigCandidates(): string[] {
  const appdata = process.env.APPDATA || '';
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const out: string[] = [];
  if (appdata) {
    out.push(path.join(appdata, 'Code', 'User', 'mcp.json'));
    out.push(path.join(appdata, 'Code - Insiders', 'User', 'mcp.json'));
  }
  if (home) {
    out.push(path.join(home, '.vscode', 'mcp.json'));
  }
  return out;
}
