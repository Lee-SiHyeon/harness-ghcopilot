import * as fs from 'fs';
import * as path from 'path';
import { HarnessPaths } from './paths';
import { redactSecrets } from './redaction';

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

const EXACT_TEST_COMMANDS = new Set([
  'npm test',
  'npm run test',
  'pnpm test',
  'pnpm run test',
  'yarn test',
  'yarn run test',
]);

function commandTokens(command: string): string[] | undefined {
  if (/[;&|<>`$\r\n]/.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
}

export function isTestCommand(command: string): boolean {
  const tokens = commandTokens(command);
  return !!tokens && EXACT_TEST_COMMANDS.has(tokens.map(t => t.toLowerCase()).join(' '));
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
  // Invalidate previous evidence so any valid PASS must be recorded after this change
  writeJson(paths.testEvidencePath, { ts: null, status: null });
}

export function recordTestEvidence(
  paths: HarnessPaths,
  evidence: Omit<TestEvidence, 'ts'> & { ts?: string | null },
): TestEvidence {
  const record = {
    ts: evidence.ts || new Date().toISOString(),
    ...evidence,
    command: evidence.command ? redactSecrets(evidence.command) : evidence.command,
    evidence: evidence.evidence ? redactSecrets(evidence.evidence) : evidence.evidence,
  };
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
  const lower = output.toLowerCase();
  const hasFail = /\b(failed|failure|error)\b|\d+\s+failed|tests\s+failed/i.test(lower);
  const hasPass = /\b(pass|passed|passing|all tests passed|ok)\b|\d+\s+passed|tests\s+passed/i.test(lower);
  if (exitCode !== 0) return 'FAIL';
  return hasPass && !hasFail ? 'PASS' : 'FAIL';
}
