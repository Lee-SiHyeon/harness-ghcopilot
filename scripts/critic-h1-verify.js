#!/usr/bin/env node
'use strict';
/**
 * critic-h1-verify.js — Critic H1 검증용 서브에이전트 실행 증거 추출
 * 사용법: node .github/scripts/critic-h1-verify.js [sessionId]
 * 출력: JSON — { sessionId, events: [{agentName, startTs, stopTs, durationMs, seq}], count }
 */
const fs   = require('fs');
const path = require('path');

const sessionId = process.argv[2] || '';
const JSONL_PATH = path.resolve(__dirname, '..', 'logs', 'subagent-flow.jsonl');

let raw;
try {
  raw = fs.readFileSync(JSONL_PATH, 'utf8');
} catch (e) {
  console.log(JSON.stringify({ error: 'subagent-flow.jsonl 읽기 실패: ' + e.message }));
  process.exit(0);
}

const lines = raw.split('\n').filter(l => l.trim());
const events = [];

for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch (_) { continue; }
  if (obj.event !== 'SubagentStop') continue;
  if (sessionId && obj.sessionId !== sessionId) continue;
  events.push({
    agentName:  obj.agentName || '(null)',
    seq:        obj.seq,
    startTs:    obj.startTs,
    stopTs:     obj.stopTs || obj.ts,
    durationMs: obj.durationMs,
  });
}

// 최근 100개만 출력 (너무 많으면 컨텍스트 초과)
const recent = events.slice(-100);
console.log(JSON.stringify({ sessionId: sessionId || '(all)', count: recent.length, events: recent }, null, 2));
