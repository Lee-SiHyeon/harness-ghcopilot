import * as fs from 'fs';
import * as crypto from 'crypto';
import { HarnessPaths } from './paths';

export interface SubagentFlowEvent {
  event: 'SubagentStart' | 'SubagentStop' | 'MaestroSessionStart';
  agentName: string | null;
  sessionId?: string | null;
  correlationId?: string;
  ts?: string;
  startTs?: string;
  stopTs?: string;
  durationMs?: number | null;
  source?: string;
  [extra: string]: unknown;
}

const FLOW_NAME = 'subagent-flow.jsonl';

export function newCorrelationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

export function appendFlow(paths: HarnessPaths, event: SubagentFlowEvent): void {
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(paths.log(FLOW_NAME), line, 'utf8');
  } catch {
    /* logging failure must never break flow */
  }
}
