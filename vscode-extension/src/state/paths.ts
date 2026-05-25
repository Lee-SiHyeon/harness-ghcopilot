import * as fs from 'fs';
import * as path from 'path';

/**
 * harnessPath 기반 경로 헬퍼 - 모든 state 파일은 harness/logs/ 아래.
 * spawn cwd는 harness의 부모이므로, hook scripts가 process.cwd()/.github/logs/...로
 * 접근하는 것과 같은 위치를 가리키게 된다.
 */
export class HarnessPaths {
  constructor(
    public readonly harnessPath: string,
    private readonly activeWorkspaceRoot?: string,
  ) {}

  get workspaceRoot(): string {
    return path.resolve(this.activeWorkspaceRoot || path.dirname(path.resolve(this.harnessPath)));
  }

  get logsDir(): string {
    return path.join(this.harnessPath, 'logs');
  }
  get agentsDir(): string {
    return path.join(this.harnessPath, 'agents');
  }
  get metaDir(): string {
    return path.join(this.harnessPath, 'meta');
  }
  log(name: string): string {
    return path.join(this.logsDir, name);
  }
  get testEvidencePath(): string {
    return this.log('test-evidence.json');
  }
  get testGateStatePath(): string {
    return this.log('test-gate-state.json');
  }
  get retrospectiveDraftPath(): string {
    return this.log('retrospective-draft.json');
  }
  get retroJsonlPath(): string {
    return this.log('retro.jsonl');
  }
  meta(name: string): string {
    return path.join(this.metaDir, name);
  }
  agent(filename: string): string {
    return path.join(this.agentsDir, filename);
  }
}

export interface ResolvedWorkspacePath {
  abs: string;
  rel: string;
  allowed: boolean;
  symlinkBlocked: boolean;
  rootKind: 'workspace' | 'harness' | 'outside';
}

function realpathIfExists(absPath: string): string {
  try {
    return fs.realpathSync.native(absPath);
  } catch {
    const parent = path.dirname(absPath);
    if (parent === absPath) return path.resolve(absPath);
    return path.join(realpathIfExists(parent), path.basename(absPath));
  }
}

function containsSymlink(absPath: string, rootPath: string): boolean {
  const root = path.resolve(rootPath);
  const target = path.resolve(absPath);
  if (!isPathInsideRoot(target, root)) return false;
  const rel = path.relative(root, target);
  if (!rel) return false;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function isPathInsideRoot(absPath: string, rootPath: string): boolean {
  const rel = path.relative(path.resolve(rootPath), path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function displayRelativePath(paths: HarnessPaths, absPath: string): string {
  const abs = path.resolve(absPath);
  const workspaceRoot = paths.workspaceRoot;
  if (isPathInsideRoot(abs, workspaceRoot)) {
    return path.relative(workspaceRoot, abs).replace(/\\/g, '/') || '.';
  }
  const harnessPath = path.resolve(paths.harnessPath);
  if (isPathInsideRoot(abs, harnessPath)) {
    const rel = path.relative(harnessPath, abs).replace(/\\/g, '/');
    return rel ? `.github/${rel}` : '.github';
  }
  return abs;
}

export function resolveWorkspacePath(paths: HarnessPaths, targetPath: string): ResolvedWorkspacePath {
  const workspaceRoot = paths.workspaceRoot;
  const harnessPath = path.resolve(paths.harnessPath);
  const abs = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspaceRoot, targetPath);
  const realAbs = realpathIfExists(abs);
  const realWorkspaceRoot = realpathIfExists(workspaceRoot);
  const realHarnessPath = realpathIfExists(harnessPath);
  const withinWorkspace = isPathInsideRoot(realAbs, realWorkspaceRoot);
  const withinHarness = isPathInsideRoot(realAbs, realHarnessPath);
  const lexicalWithinWorkspace = isPathInsideRoot(abs, workspaceRoot);
  const lexicalWithinHarness = isPathInsideRoot(abs, harnessPath);
  const symlinkBlocked =
    (lexicalWithinWorkspace && containsSymlink(abs, workspaceRoot)) ||
    (lexicalWithinHarness && containsSymlink(abs, harnessPath));
  const rel = displayRelativePath(paths, abs);
  return {
    abs,
    rel,
    allowed: (withinWorkspace || withinHarness) && !symlinkBlocked,
    symlinkBlocked,
    rootKind: withinWorkspace ? 'workspace' : withinHarness ? 'harness' : 'outside',
  };
}

