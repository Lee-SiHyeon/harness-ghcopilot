#!/usr/bin/env node
/**
 * subagent-stop-logger.js — SubagentStop 이벤트 로거
 *
 * SubagentStop 이벤트에서 실행.
 * last-subagent-start.json을 읽어 duration/correlationId를 계산하고
 * subagent-flow.jsonl 및 hook-audit.jsonl에 기록한다.
 *
 * fail-open: 어떤 에러가 발생해도 {continue: true} 반환.
 * 런타임 미지원(SubagentStop 이벤트 미존재) 환경에서도 안전.
 *
 * 환경변수:
 *   SUBAGENT_NAME   호출된 서브에이전트 이름
 *   AGENT_NAME      대체 에이전트 이름
 *   SESSION_ID      세션 ID
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const { isToolCallId } = require('./shared-utils');

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}

function trySubagentFlow(obj) {
  if (!audit) return;
  try { audit.appendSubagentFlow(obj); } catch (_) {}
}

function tryAudit(obj) {
  if (!audit) return;
  try { audit.appendAudit(obj); } catch (_) {}
}

(async () => {
  try {
    // ── stdin JSON 파싱 (SubagentStop 훅 데이터) ──────────────────
    let stdinData = null;
    try {
      if (!process.stdin.isTTY) {
        const chunks = [];
        let totalBytes = 0;
        const MAX_STDIN_BYTES = 64 * 1024;
        for await (const chunk of process.stdin) {
          totalBytes += chunk.length;
          if (totalBytes > MAX_STDIN_BYTES) { chunks.length = 0; stdinData = null; break; }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw) stdinData = JSON.parse(raw);
      }
    } catch (_) {}
    const rawAgentId   = stdinData?.agent_id || '';
    const rawAgentType = stdinData?.agent_type || '';
    // VS Code builtin sentinel값과 Tool Call ID 필터링
    const filteredAgentType = (rawAgentType === 'default' || isToolCallId(rawAgentType)) ? '' : rawAgentType;
    const agentName = (
      filteredAgentType ||
      (isToolCallId(rawAgentId) ? '' : rawAgentId) ||
      stdinData?.agent_name || stdinData?.agentName ||
      process.env.SUBAGENT_NAME || process.env.AGENT_NAME || ''
    ).trim();
    const sessionId = (stdinData?.session_id || stdinData?.sessionId || process.env.SESSION_ID || '').trim();
    const ts        = new Date().toISOString();

    const logsDir       = path.resolve(process.cwd(), '.github', 'logs');
    const lastStartFile = path.join(logsDir, 'last-subagent-start.json');

    let correlationId = null;
    let durationMs    = null;
    let startTs       = null;
    let fallbackUsed  = false;
    let fallbackType  = 'none';
    let inferredAgentName = null;

    try {
      const starts = JSON.parse(fs.readFileSync(lastStartFile, 'utf8'));
      let entry    = null;

      // agentName별 배열에서 sessionId 매칭 항목 pop (가장 최근 우선)
      if (agentName && Array.isArray(starts[agentName]) && starts[agentName].length > 0) {
        const arr = starts[agentName];
        let idx   = -1;
        if (sessionId) {
          for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].sessionId === sessionId) { idx = i; break; }
          }
        }
        if (idx >= 0) {
          entry = arr.splice(idx, 1)[0];
          // fallbackType stays 'none' — session matched
        } else {
          // sessionId 미매칭 → 최근 항목 fallback
          entry = arr.pop();
          fallbackUsed = true;
          fallbackType = 'session_mismatch';
        }
        if (arr.length === 0) delete starts[agentName];
        try { fs.writeFileSync(lastStartFile, JSON.stringify(starts, null, 2), 'utf8'); } catch (_) {}
      } else if (starts['__last__']) {
        entry = starts['__last__'];
        fallbackUsed = true;
        fallbackType = 'global_last';
      }

      if (!entry) fallbackType = 'no_start_record';

      if (entry) {
        inferredAgentName = entry.agentName || null;
        correlationId = entry.correlationId || null;
        startTs       = entry.startTs || entry.ts || null;  // backward compat
        if (startTs) {
          const ms = new Date(ts).getTime() - new Date(startTs).getTime();
          durationMs = Number.isFinite(ms) ? Math.max(0, ms) : null;
        }
      }
    } catch (_) {}

    const seq = audit ? audit.nextSeq() : 0;

    trySubagentFlow({
      event:         'SubagentStop',
      agentName:     agentName || inferredAgentName || null,
      sessionId:     sessionId || null,
      seq,
      correlationId,
      startTs,
      stopTs:        ts,
      durationMs,
      fallbackType,
      ...(fallbackUsed ? { fallbackUsed: true } : {}),
    });

    try {
      const { recordStop } = require('../../mcp-server/state-lib/pipeline.js');
      recordStop(agentName || inferredAgentName || '', sessionId || '');
    } catch (_) {}

    tryAudit({
      event:         'subagent_stop',
      source:        'SubagentStop',
      agentName:     agentName || inferredAgentName || null,
      sessionId:     sessionId || null,
      seq,
      correlationId,
      durationMs,
      fallbackType,
      ...(fallbackUsed ? { fallbackUsed: true } : {}),
    });
  } catch (_) {
    // 완전한 fail-open
  }

  process.stdout.write(JSON.stringify({ continue: true }));
})();
