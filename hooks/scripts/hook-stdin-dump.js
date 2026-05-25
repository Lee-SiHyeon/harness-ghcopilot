#!/usr/bin/env node
/**
 * hook-stdin-dump.js — Hook stdin 진단 덤프 (개발/디버그 전용)
 *
 * 모든 훅 이벤트에 추가하면 VS Code가 실제로 전달하는
 * stdin 필드와 env vars를 dump.jsonl에 기록한다.
 *
 * 사용법: hook JSON 파일에 이 스크립트를 각 이벤트에 추가
 * 주의: 민감 데이터(API키 등)가 dump될 수 있음 — 개발 환경에서만 사용
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DUMP_FILE = path.resolve(process.cwd(), '.github/logs/stdin-dump.jsonl');
const SENSITIVE_RE = /(?:authorization\s*:[^\n\r]*|bearer\s+\S+|(?:token|api[_-]?key|apikey|password|secret)\s*[=:]\s*\S+)/gi;
function redact(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(new RegExp(SENSITIVE_RE.source, SENSITIVE_RE.flags), '[REDACTED]');
}

(async () => {
  let stdinRaw = '';
  let stdinParsed = null;
  try {
    if (!process.stdin.isTTY) {
      const chunks = [];
      let totalBytes = 0;
      const MAX_STDIN_BYTES = 64 * 1024;
      for await (const c of process.stdin) {
        totalBytes += c.length;
        if (totalBytes > MAX_STDIN_BYTES) { stdinParsed = null; break; }
        chunks.push(c);
      }
      stdinRaw = Buffer.concat(chunks).toString('utf8').trim();
      if (stdinRaw) stdinParsed = JSON.parse(stdinRaw);
    }
  } catch (_) {}

  const HOOK_ENV_KEYS = [
    'TOOL_NAME','TOOL_INPUT','TOOL_RESULT','AGENT_NAME','SUBAGENT_NAME',
    'SESSION_ID','USER_PROMPT','HOOK_EVENT_NAME',
  ];
  const envSnapshot = {};
  for (const k of HOOK_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) envSnapshot[k] = redact(v.slice(0, 200));
  }

  const entry = {
    ts:  new Date().toISOString(),
    // 공통 stdin 필드
    hookEventName:   stdinParsed?.hookEventName,
    sessionId:       stdinParsed?.sessionId,
    timestamp:       stdinParsed?.timestamp,
    cwd:             stdinParsed?.cwd,
    transcript_path: stdinParsed?.transcript_path,
    // 이벤트별 고유 stdin 필드
    tool_name:        stdinParsed?.tool_name,
    tool_use_id:      stdinParsed?.tool_use_id,
    tool_input_keys:  stdinParsed?.tool_input ? Object.keys(stdinParsed.tool_input) : null,
    tool_response_preview: typeof stdinParsed?.tool_response === 'string'
      ? redact(stdinParsed.tool_response.slice(0, 100)) : stdinParsed?.tool_response,
    prompt_len:       typeof stdinParsed?.prompt === 'string' ? stdinParsed.prompt.length : null,
    agent_id:         stdinParsed?.agent_id,
    agent_type:       stdinParsed?.agent_type,
    stop_hook_active: stdinParsed?.stop_hook_active,
    trigger:          stdinParsed?.trigger,
    source:           stdinParsed?.source,
    // 전체 stdin 키 목록 (필드 발견용)
    stdinKeys:        stdinParsed ? Object.keys(stdinParsed) : null,
    // env vars (비교용)
    envProvided:      envSnapshot,
  };

  try {
    fs.mkdirSync(path.dirname(DUMP_FILE), { recursive: true });
    fs.appendFileSync(DUMP_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
})();
