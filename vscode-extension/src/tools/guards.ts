/**
 * TS 측 가드 - meta/guards.json SSOT 로드.
 * hooks/scripts/shared-utils.js의 JS 측 가드와 동일 데이터 사용.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HarnessPaths, resolveWorkspacePath } from '../state/paths';

/** 중칭 반복자(catastrophic backtracking) 팔쾎이 있으면true 반환 */
function isReDoSRisk(pattern: string): boolean {
  // (X+)+ / (X*)* / (X+)* 형태의 중칭 quantifier 쿬지
  return /(\(.*[+*?]\))[+*?]/.test(pattern) ||
         /(\[.*\])[+*?].*[+*?]/.test(pattern);
}

export interface GuardData {
  protectedDirs: string[];
  protectedFiles: string[];
  sensitiveExtensions: string[];
  envFilenamePattern: string;
  lockFiles: string[];
  destructiveCommands: Array<{
    name: string;
    regex: string;
    flags: string;
    appliesTo?: string[];
  }>;
}

const FALLBACK: GuardData = {
  protectedDirs: [],
  protectedFiles: [],
  sensitiveExtensions: [],
  envFilenamePattern: '\\.env(\\.[a-z]+)?$',
  lockFiles: [],
  destructiveCommands: [],
};

let cache: GuardData | null = null;
let cacheKey = '';

export function loadGuards(paths: HarnessPaths): GuardData {
  const key = paths.harnessPath;
  if (cache && cacheKey === key) return cache;
  try {
    const raw = fs.readFileSync(paths.meta('guards.json'), 'utf8');
    cache = JSON.parse(raw) as GuardData;
  } catch {
    cache = { ...FALLBACK };
  }
  cacheKey = key;
  return cache;
}

export type CommandDecision = 'allow' | 'deny';

export interface CommandCheckResult {
  decision: CommandDecision;
  matched: string[];
  reason?: string;
  executable?: string;
  args?: string[];
  canonical?: string;
}

const PACKAGE_TEST_COMMANDS = new Set([
  'npm test',
  'npm run test',
  'pnpm test',
  'pnpm run test',
  'yarn test',
  'yarn run test',
]);

function splitCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!quote && /[;&|<>`$\r\n]/.test(ch)) return undefined;
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? undefined : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) return undefined;
  if (current) tokens.push(current);
  return tokens;
}

function hasPackageTestScript(cwd: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim().length > 0;
  } catch {
    return false;
  }
}

function executableFor(command: string): string {
  if (process.platform !== 'win32') return command;
  return ['npm', 'pnpm', 'yarn'].includes(command) ? `${command}.cmd` : command;
}

export function checkCommand(paths: HarnessPaths, command: string, cwd?: string): CommandCheckResult {
  const guards = loadGuards(paths);
  const matched: string[] = [];
  for (const entry of guards.destructiveCommands) {
    if (Array.isArray(entry.appliesTo) && !entry.appliesTo.includes('js')) continue;
    if (isReDoSRisk(entry.regex)) continue;
    try {
      const re = new RegExp(entry.regex, entry.flags || '');
      if (re.test(command)) matched.push(entry.name);
    } catch { /* skip invalid pattern */ }
  }
  if (matched.length > 0) return { decision: 'deny', matched, reason: 'destructive command pattern' };

  const tokens = splitCommand(command.trim());
  if (!tokens || tokens.length === 0) {
    return { decision: 'deny', matched: ['unsafe-shell-syntax'], reason: 'shell metacharacter, newline, or unterminated quote' };
  }

  const canonical = tokens.map(t => t.toLowerCase()).join(' ');
  if (!PACKAGE_TEST_COMMANDS.has(canonical)) {
    return { decision: 'deny', matched: ['not-allowlisted'], reason: 'only exact package-manager test commands are allowed' };
  }

  const effectiveCwd = cwd || paths.workspaceRoot;
  if (!hasPackageTestScript(effectiveCwd)) {
    return { decision: 'deny', matched: ['missing-test-script'], reason: 'cwd package.json has no scripts.test' };
  }

  return {
    decision: 'allow',
    matched,
    executable: executableFor(tokens[0]),
    args: tokens.slice(1),
    canonical,
  };
}

export type FileDecision = 'allow' | 'ask' | 'deny';

export interface FileCheckResult {
  decision: FileDecision;
  reason?: string;
}

/**
 * 단일 파일 경로에 대한 가드 판정.
 *
 * 우선순위: configured workspace roots 외부 -> deny, env/민감 확장자 -> deny,
 *           maestro.agent.md -> ask (자기수정 정책은 호출자가 추가 검증),
 *           protected dir -> ask, 그 외 -> allow.
 */
export function checkFileWrite(paths: HarnessPaths, targetPath: string): FileCheckResult {
  const guards = loadGuards(paths);
  const resolved = resolveWorkspacePath(paths, targetPath);
  if (!resolved.allowed) {
    return { decision: 'deny', reason: resolved.symlinkBlocked ? 'symlink 경로는 허용하지 않음' : 'configured workspace roots 외부 경로' };
  }

  const basename = path.basename(resolved.abs).toLowerCase();
  const ext = path.extname(basename).toLowerCase();
  if (!isReDoSRisk(guards.envFilenamePattern)) {
    try {
      if (new RegExp(guards.envFilenamePattern, 'i').test(basename)) {
        return { decision: 'deny', reason: '.env* 민감 파일' };
      }
    } catch { /* skip */ }
  }
  if (guards.sensitiveExtensions.some(e => e.toLowerCase() === ext)) {
    return { decision: 'deny', reason: `민감 확장자 (${ext})` };
  }
  if (guards.protectedFiles.some(f => basename === f.toLowerCase())) {
    return { decision: 'ask', reason: `보호 파일 (${basename})` };
  }
  for (const dir of guards.protectedDirs) {
    if (resolved.rel.startsWith(`.github/${dir}/`)) {
      return { decision: 'ask', reason: `보호 디렉토리 (.github/${dir}/)` };
    }
  }
  return { decision: 'allow' };
}
