#!/usr/bin/env node
/**
 * subagent-start-validator.js — SubagentStart 입력 검증 훅
 *
 * 입력: stdin JSON (SubagentStart 이벤트)
 * 출력: { continue: true } (항상 — fail-open)
 * 부작용: logs/agent-io-results.jsonl에 결과 기록
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { validateInputs, loadContract } = require('./io-validator');
const { isToolCallId } = require('./shared-utils');

const LOGS_DIR        = path.resolve(process.cwd(), '.github', 'logs');
const IO_RESULTS_PATH = path.join(LOGS_DIR, 'agent-io-results.jsonl');
const FLOW_PATH       = path.join(LOGS_DIR, 'subagent-flow.jsonl');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function appendResult(entry) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(IO_RESULTS_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

function loadFlowLines(sessionId) {
  try {
    const raw = fs.readFileSync(FLOW_PATH, 'utf8');
    return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch(_) { return null; } }).filter(Boolean)
      .filter(l => !sessionId || l.sessionId === sessionId);
  } catch (_) { return []; }
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
    const prompt    = stdinData?.prompt_summary || stdinData?.prompt || process.env.USER_PROMPT || '';
    const ts        = new Date().toISOString();

    if (!agentName) { out({ continue: true }); return; }

    const contract = loadContract(agentName);
    if (!contract) { out({ continue: true }); return; }

    const flowLines = loadFlowLines(sessionId);
    const result    = validateInputs(agentName, { agentName, sessionId, prompt, flowLines });

    const level = contract.validation_level === 'hard' && !result.ok ? 'FAIL'
                : result.warnings.length > 0                          ? 'WARN'
                : 'PASS';

    appendResult({ event: 'INPUT_' + level, level, agentName, sessionId, ts,
                   missing: result.missing, warnings: result.warnings });
  } catch (_) {}

  out({ continue: true });
})();