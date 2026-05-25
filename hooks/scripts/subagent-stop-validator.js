#!/usr/bin/env node
/**
 * subagent-stop-validator.js — SubagentStop 출력 검증 + retry 큐 push
 *
 * 입력: stdin JSON (SubagentStop 이벤트)
 * 출력: { continue: true } (항상 — fail-open)
 * 부작용:
 *   - logs/agent-io-results.jsonl에 PASS/FAIL/FATAL 기록
 *   - FAIL 시 logs/agent-retry-queue.json에 항목 push
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { validateOutputs, loadContracts, loadContract } = require('./io-validator');
const { isToolCallId } = require('./shared-utils');

const LOGS_DIR         = path.resolve(process.cwd(), '.github', 'logs');
const IO_RESULTS_PATH  = path.join(LOGS_DIR, 'agent-io-results.jsonl');
const RETRY_QUEUE_PATH = path.join(LOGS_DIR, 'agent-retry-queue.json');
const FLOW_PATH        = path.join(LOGS_DIR, 'subagent-flow.jsonl');
const LAST_START_PATH  = path.join(LOGS_DIR, 'last-subagent-start.json');
const FILE_CHANGES_PATH = path.join(LOGS_DIR, 'file-change-log.jsonl');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function appendResult(entry) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(IO_RESULTS_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

function readRetryQueue() {
  try { return JSON.parse(fs.readFileSync(RETRY_QUEUE_PATH, 'utf8')); }
  catch (_) { return []; }
}

function writeRetryQueue(queue) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const tmp = RETRY_QUEUE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2), 'utf8');
    fs.renameSync(tmp, RETRY_QUEUE_PATH);
  } catch (_) {}
}

function loadFlowLines() {
  try {
    return fs.readFileSync(FLOW_PATH, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch(_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function loadFileChangeLines() {
  try {
    return fs.readFileSync(FILE_CHANGES_PATH, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch(_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function getStartTs(agentName, sessionId) {
  try {
    const starts = JSON.parse(fs.readFileSync(LAST_START_PATH, 'utf8'));
    const arr = Array.isArray(starts) ? starts : [starts];
    const entry = arr.reverse().find(e =>
      (e.agentName || '').toLowerCase() === agentName.toLowerCase() &&
      (!sessionId || e.sessionId === sessionId)
    );
    return entry?.startTs || entry?.ts || null;
  } catch (_) { return null; }
}

(async () => {
  try {
    let stdinData = null;
    try {
      if (!process.stdin.isTTY) {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw) stdinData = JSON.parse(raw);
      }
    } catch (_) {}

    const rawAgentId   = stdinData?.agent_id   || '';
    const rawAgentType = stdinData?.agent_type  || '';
    const filteredType = (rawAgentType === 'default' || isToolCallId(rawAgentType)) ? '' : rawAgentType;
    const agentName = (
      filteredType ||
      (isToolCallId(rawAgentId) ? '' : rawAgentId) ||
      stdinData?.agent_name || stdinData?.agentName ||
      process.env.SUBAGENT_NAME || process.env.AGENT_NAME || ''
    ).trim();

    const sessionId = (stdinData?.session_id || stdinData?.sessionId || process.env.SESSION_ID || '').trim();
    const ts        = new Date().toISOString();

    if (!agentName) { out({ continue: true }); return; }

    const contract = loadContract(agentName);
    if (!contract) { out({ continue: true }); return; }

    const startTs        = getStartTs(agentName, sessionId);
    const flowLines      = loadFlowLines();
    const fileChangeLines= loadFileChangeLines();

    const result = validateOutputs(agentName, { agentName, sessionId, startTs, flowLines, fileChangeLines });

    if (!result.ok) {
      const contracts  = loadContracts();
      const maxRetries = contracts?.maxRetries ?? 3;
      const queue      = readRetryQueue();

      const idx = queue.findIndex(e =>
        e.agentName === agentName &&
        e.sessionId === sessionId &&
        !e.consumed
      );
      const existing   = idx >= 0 ? queue[idx] : null;
      const retryCount = existing ? existing.retryCount + 1 : 1;

      if (existing && existing.retryCount >= maxRetries) {
        appendResult({ event: 'OUTPUT_FATAL', level: 'FATAL', agentName, sessionId, ts,
                       missing: result.missing, retryCount: existing.retryCount });
      } else {
        const entry = { agentName, reason: result.missing.join('; '), retryCount, sessionId, ts, consumed: false };
        if (idx >= 0) queue[idx] = entry; else queue.push(entry);
        writeRetryQueue(queue);
        appendResult({ event: 'OUTPUT_FAIL', level: 'FAIL', agentName, sessionId, ts,
                       missing: result.missing, warnings: result.warnings, retryCount });
      }
    } else {
      appendResult({ event: 'OUTPUT_PASS', level: 'PASS', agentName, sessionId, ts,
                     warnings: result.warnings });
    }
  } catch (_) {}

  out({ continue: true });
})();