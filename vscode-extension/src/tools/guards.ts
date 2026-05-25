/**
 * TS 측 가드 — meta/guards.json SSOT 로드.
 * hooks/scripts/shared-utils.js의 JS 측 가드와 동일 데이터 사용.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HarnessPaths } from '../state/paths';

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
}

export function checkCommand(paths: HarnessPaths, command: string): CommandCheckResult {
  const guards = loadGuards(paths);
  const matched: string[] = [];
  for (const entry of guards.destructiveCommands) {
    if (Array.isArray(entry.appliesTo) && !entry.appliesTo.includes('js')) continue;
    try {
      const re = new RegExp(entry.regex, entry.flags || '');
      if (re.test(command)) matched.push(entry.name);
    } catch { /* skip invalid pattern */ }
  }
  return { decision: matched.length > 0 ? 'deny' : 'allow', matched };
}

export type FileDecision = 'allow' | 'ask' | 'deny';

export interface FileCheckResult {
  decision: FileDecision;
  reason?: string;
}

/**
 * 단일 파일 경로에 대한 가드 판정.
 *
 * 우선순위: workspace 외부 → deny, env/민감 확장자 → deny,
 *           maestro.agent.md → ask (자기수정 정책은 호출자가 추가 검증),
 *           protected dir → ask, 그 외 → allow.
 */
export function checkFileWrite(paths: HarnessPaths, targetPath: string): FileCheckResult {
  const guards = loadGuards(paths);
  const harnessRoot = path.dirname(path.resolve(paths.harnessPath));
  const absolute = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(harnessRoot, targetPath);
  const rel = path.relative(harnessRoot, absolute).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { decision: 'deny', reason: 'workspace 외부 경로' };
  }

  const basename = path.basename(absolute).toLowerCase();
  const ext = path.extname(basename).toLowerCase();
  try {
    if (new RegExp(guards.envFilenamePattern, 'i').test(basename)) {
      return { decision: 'deny', reason: '.env* 민감 파일' };
    }
  } catch { /* skip */ }
  if (guards.sensitiveExtensions.some(e => e.toLowerCase() === ext)) {
    return { decision: 'deny', reason: `민감 확장자 (${ext})` };
  }
  if (guards.protectedFiles.some(f => basename === f.toLowerCase())) {
    return { decision: 'ask', reason: `보호 파일 (${basename})` };
  }
  for (const dir of guards.protectedDirs) {
    if (rel.startsWith(`.github/${dir}/`)) {
      return { decision: 'ask', reason: `보호 디렉토리 (.github/${dir}/)` };
    }
  }
  return { decision: 'allow' };
}
