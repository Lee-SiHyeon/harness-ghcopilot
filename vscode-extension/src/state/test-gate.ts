import * as fs from 'fs';
import * as path from 'path';
import { HarnessPaths } from './paths';

export interface TestEvidence {
  ts: string | null;
  command?: string;
  result?: 'PASS' | 'FAIL';
  status?: 'PASS' | 'FAIL' | null;
  exitCode?: number | null;
  evidence?: string;
}

export interface TestGateState {
  requiredSince?: string | null;
  lastChangeAt?: string | null;
  lastChangeTool?: string | null;
  warnedTodoKeys?: string[];
  lastWarnedStateSignature?: string | null;
}

const TEST_CMD_PATTERNS = [
  /\bnpm\s+(run\s+)?test\b/i,
  /\bpnpm\s+(run\s+)?test\b/i,
  /\byarn\s+(run\s+)?test\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bpytest\b/i,
  /\bpython\s+-m\s+pytest\b/i,
  /\bgo\s+test\b/i,
  /\bcargo\s+test\b/i,
  /\bmvn\s+(.*\s+)?test\b/i,
  /\bgradle\s+(.*\s+)?test\b/i,
  /\bmocha\b/i,
  /\bnpx\s+(vitest|jest|mocha)\b/i,
  /\bnode\s+tests\/maestro-suite\.test\.js\b/i,
];

export function isTestCommand(command: string): boolean {
  return TEST_CMD_PATTERNS.some(p => p.test(command));
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function getGateState(paths: HarnessPaths): TestGateState {
  return readJson(paths.testGateStatePath, {});
}

export function setGateState(paths: HarnessPaths, patch: TestGateState): TestGateState {
  const next = { ...getGateState(paths), ...patch };
  writeJson(paths.testGateStatePath, next);
  return next;
}

export function markFileChanged(paths: HarnessPaths, toolName: string, changedPath: string): void {
  const normalized = changedPath.replace(/\\/g, '/');
  if (normalized.includes('/.github/logs/')) return;
  const now = new Date().toISOString();
  setGateState(paths, {
    requiredSince: now,
    lastChangeAt: now,
    lastChangeTool: toolName,
    warnedTodoKeys: [],
    lastWarnedStateSignature: null,
  });
}

export function recordTestEvidence(
  paths: HarnessPaths,
  evidence: Omit<TestEvidence, 'ts'> & { ts?: string | null },
): TestEvidence {
  const record = { ts: evidence.ts || new Date().toISOString(), ...evidence };
  writeJson(paths.testEvidencePath, record);
  return record;
}

export function getTestEvidence(paths: HarnessPaths): TestEvidence {
  return readJson(paths.testEvidencePath, { ts: null, status: null });
}

export function isEvidenceValid(paths: HarnessPaths): boolean {
  const evidence = getTestEvidence(paths);
  const passValue = evidence.status || evidence.result;
  if (passValue !== 'PASS' || !evidence.ts) return false;
  const gate = getGateState(paths);
  if (!gate.requiredSince) return true;
  return new Date(evidence.ts) >= new Date(gate.requiredSince);
}

export function determineTestResult(exitCode: number | null, output: string): 'PASS' | 'FAIL' {
  if (exitCode !== null) return exitCode === 0 ? 'PASS' : 'FAIL';
  const lower = output.toLowerCase();
  const hasFail = /\b(failed|failure|error)\b|\d+\s+failed|tests\s+failed/i.test(lower);
  const hasPass = /\b(passed|all.*pass|ok)\b|\d+\s+passed|tests\s+passed/i.test(lower);
  return hasPass && !hasFail ? 'PASS' : 'FAIL';
}
