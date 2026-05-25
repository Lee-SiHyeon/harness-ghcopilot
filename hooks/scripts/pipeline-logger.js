#!/usr/bin/env node
/**
 * pipeline-logger.js — PostToolUse Observability Hook
 *
 * PostToolUse 단계에서 실행. 에이전트 파이프라인 실행 이력을
 * .github/logs/pipeline.jsonl 에 NDJSON으로 기록한다.
 *
 * 환경변수:
 *   TOOL_NAME       실행된 도구 이름
 *   TOOL_INPUT      도구 입력 (JSON 문자열)
 *   TOOL_RESULT     도구 결과 (JSON 문자열)
 *   AGENT_NAME      현재 에이전트 이름
 *   SESSION_ID      세션 ID
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let toolName  = 'unknown';
let agentName = 'unknown';
let sessionId = 'unknown';

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

// 로그 디렉터리 (fail-open: 실패해도 무시)
const logsDir = path.resolve(process.cwd(), '.github', 'logs');
try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}

// 고비용·위험 도구는 반드시 기록
const ALWAYS_LOG = new Set([
  'edit_file', 'create_file', 'delete_file', 'rename_file',
  'run_in_terminal', 'execute_command',
  'web_search', 'fetch',
]);

// 반복성 읽기/검색 도구는 경량 메트릭만 기록 (노이즈 감소)
const SKIP_LOG = new Set([
  'read_file', 'list_dir', 'grep_search', 'file_search', 'semantic_search',
]);

// 도구 아이콘 매핑
const TOOL_ICON = {
  edit_file: '✏️', create_file: '📄', delete_file: '🗑️', rename_file: '🔀',
  run_in_terminal: '💻', execute_command: '💻',
  web_search: '🌐', fetch: '🌐',
};

// ── 경량 메트릭 기록 (SKIP_LOG 도구용) ──────────────────────────
function _extractInputHint(inp) {
  if (!inp) return null;
  const h = inp.path || inp.filePath || inp.file_path || inp.command || inp.query || inp.pattern || inp.glob || '';
  return h ? String(h).slice(0, 100) : null;
}

function _recordMetricsOnly(tool) {
  try {
    let inp = null;
    try { inp = JSON.parse(process.env.TOOL_INPUT || 'null'); } catch (_) {}
    const ts   = new Date().toISOString();
    const hint = _extractInputHint(inp);

    // 1. tool-metrics.jsonl
    try {
      fs.appendFileSync(
        path.join(logsDir, 'tool-metrics.jsonl'),
        JSON.stringify({ ts, tool, agent: agentName, session: sessionId, hint }) + '\n', 'utf8'
      );
    } catch (_) {}

    // 2. tool-stats.json (집계 카운터)
    try {
      const sf = path.join(logsDir, 'tool-stats.json');
      let stats = {};
      try { stats = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (_) {}
      stats[tool] = (stats[tool] || 0) + 1;
      stats._updatedAt = ts;
      fs.writeFileSync(sf, JSON.stringify(stats, null, 2), 'utf8');
    } catch (_) {}

    // 3. file-access-heatmap.json (read_file, list_dir)
    // Schema: { updatedAt, files: { "path": { count, lastTs, agents } } }
    if (tool === 'read_file' || tool === 'list_dir') {
      const fp = inp?.path || inp?.filePath || inp?.file_path || '';
      if (fp) {
        try {
          const hf = path.join(logsDir, 'file-access-heatmap.json');
          let raw = {};
          try { raw = JSON.parse(fs.readFileSync(hf, 'utf8')); } catch (_) {}

          // Migration: old schema { "path": count|obj, _updatedAt } → new schema { updatedAt, files }
          let hm;
          if (raw && typeof raw.files === 'object' && raw.files !== null) {
            // Already new schema
            hm = raw;
          } else {
            // Old schema — migrate
            hm = { files: {} };
            for (const [k, v] of Object.entries(raw)) {
              if (k === '_updatedAt') continue; // drop old meta key
              const cnt = typeof v === 'number' ? v : (v && typeof v.count === 'number' ? v.count : 1);
              hm.files[k] = { count: cnt, lastTs: ts, agents: [agentName] };
            }
          }

          // Upsert current access
          const entry = hm.files[fp] || { count: 0, lastTs: ts, agents: [] };
          entry.count += 1;
          entry.lastTs = ts;
          if (!Array.isArray(entry.agents)) entry.agents = [];
          if (!entry.agents.includes(agentName)) entry.agents.push(agentName);
          hm.files[fp] = entry;
          hm.updatedAt = ts;

          fs.writeFileSync(hf, JSON.stringify(hm, null, 2), 'utf8');
        } catch (_) {}
      }
    }

    // 4. search-queries.jsonl + 5. code-graph-signals.jsonl (검색 도구)
    if (tool === 'grep_search' || tool === 'file_search' || tool === 'semantic_search') {
      const q    = inp?.query || inp?.pattern || inp?.glob || '';
      const incl = inp?.includePattern || inp?.include || '';
      try {
        fs.appendFileSync(
          path.join(logsDir, 'search-queries.jsonl'),
          JSON.stringify({ ts, tool, query: String(q).slice(0, 200), includePattern: String(incl).slice(0, 100) }) + '\n', 'utf8'
        );
      } catch (_) {}
      // code-graph-signals: 코드 파일 검색 or semantic_search
      const isCodeSearch = /\.(ts|js|tsx|jsx|py|go|rs|java|cs|cpp|c|h)\b/.test(incl)
                        || /\.(ts|js|tsx|jsx|py|go|rs|java|cs|cpp|c|h)\b/.test(q);
      if (isCodeSearch || tool === 'semantic_search') {
        try {
          fs.appendFileSync(
            path.join(logsDir, 'code-graph-signals.jsonl'),
            JSON.stringify({ ts, tool, query: String(q).slice(0, 100), includePattern: String(incl).slice(0, 100), agent: agentName }) + '\n', 'utf8'
          );
        } catch (_) {}
      }
    }

    // recent-tools 링버퍼 갱신 (SKIP_LOG metrics-only도 반영)
    _updateRecentTools(tool);
    // audit: metrics-only decision
    tryAudit({ event: 'tool_decision', decision: 'metrics_only', tool, session: sessionId, agent: agentName });
  } catch (_) {}
}

// ── recent-tools.json 링버퍼 유지 (max 20) ──────────────────────
function _updateRecentTools(tool) {
  try {
    const rf = path.join(logsDir, 'recent-tools.json');
    let rt = { tools: [] };
    try { rt = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch (_) {}
    const tools = Array.isArray(rt.tools) ? rt.tools : [];
    tools.push(tool);
    if (tools.length > 20) tools.splice(0, tools.length - 20);
    fs.writeFileSync(rf, JSON.stringify({ tools, updatedAt: new Date().toISOString() }), 'utf8');
  } catch (_) {}
}

async function main() {
  // ── stdin 읽기 (PostToolUse hook 데이터) ─────────────────────────
  let stdinData = null;
  try {
    if (!process.stdin.isTTY) {
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of process.stdin) {
        totalSize += chunk.length;
        if (totalSize > 2 * 1024 * 1024) { stdinData = null; break; }
        chunks.push(chunk);
      }
      if (totalSize <= 2 * 1024 * 1024) {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw) stdinData = JSON.parse(raw);
      }
    }
  } catch (_) {}

  // stdin 필드 우선, env vars 폴백
  toolName  = stdinData?.tool_name  || stdinData?.toolName  || process.env.TOOL_NAME  || 'unknown';
  agentName = stdinData?.agent_name || stdinData?.agentName || process.env.AGENT_NAME || 'unknown';
  sessionId = stdinData?.session_id || stdinData?.sessionId || process.env.SESSION_ID || 'unknown';

  if (SKIP_LOG.has(toolName) && !ALWAYS_LOG.has(toolName) && toolName !== 'manage_todo_list') {
    // 경량 메트릭 기록 후 즉시 continue (pipeline.jsonl 기록 생략)
    _recordMetricsOnly(toolName);
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

// ── manage_todo_list: todo 상태를 파일로 영속화 ─────────────────────
if (toolName === 'manage_todo_list') {
  let todoList = [];
  try {
    let inp = stdinData?.tool_input || stdinData?.toolInput;
    if (inp == null) { try { inp = JSON.parse(process.env.TOOL_INPUT || '{}'); } catch (_) { inp = {}; } }
    todoList = (inp && typeof inp === 'object' ? inp : {}).todoList || [];
  } catch (_) {}

  // G1: todoList 필드 자체가 존재하면 빈 배열이라도 항상 저장 → stale in-progress 클리어
  const hasTodoListField = (() => {
    try {
      let inp = stdinData?.tool_input || stdinData?.toolInput;
      if (inp == null) { try { inp = JSON.parse(process.env.TOOL_INPUT || '{}'); } catch (_) { inp = {}; } }
      return inp && typeof inp === 'object' && 'todoList' in inp;
    } catch (_) { return false; }
  })();

  if (hasTodoListField) {
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}
    const stateFile = path.join(logsDir, 'current-todos.json');
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ ts: new Date().toISOString(), todos: todoList }, null, 2), 'utf8');
    } catch (_) {}
  }

  if (todoList.length > 0) {
    // 사용자 슬랙 요약 (비어있지 않을 때만)
    const STATUS_ICON = { 'completed': '✅', 'in-progress': '🔄', 'not-started': '□' };
    const lines = todoList.map(t => `${STATUS_ICON[t.status] || '?'} ${t.title}`);
    const doneCount = todoList.filter(t => t.status === 'completed').length;
    const summary = `📌 [Todo] ${doneCount}/${todoList.length} 완료 — ${lines.join(' | ')}`;

    tryAudit({ event: 'tool_decision', decision: 'todo_persist', tool: toolName, todoCount: todoList.length, session: sessionId, agent: agentName });
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: summary,
    }));
    return;
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  return;
}

// ── 민감 패턴 redact (summarize 및 redactHint 공유) ─────────────────
// audit-logger 와 동일한 강화 패턴 (URL credential, PEM, Authorization 포함)
const SENSITIVE_RE = /(?:authorization\s*:[^\n\r]*|bearer\s+\S+|(?:token|api[_-]?key|apikey|password|secret|opencode_api_key)\s*[=:]\s*\S+|https?:\/\/[^:@\s]+:[^@\s]+@\S+|-----BEGIN\s[A-Z ]+-----[\s\S]*?-----END\s[A-Z ]+-----)/gi;

// ── 입력/결과 요약 (과도한 로그 방지, 민감 정보 redact) ───────
function summarize(raw, maxLen = 300) {
  // audit-logger.summarize 재사용 (fail-open: audit 없으면 로컬 fallback)
  if (audit) { try { return audit.summarize(raw, maxLen); } catch (_) {} }
  if (!raw) return null;
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const re = new RegExp(SENSITIVE_RE.source, SENSITIVE_RE.flags);
  const redacted = str.replace(re, '[REDACTED]');
  return redacted.length > maxLen ? redacted.slice(0, maxLen) + '…' : redacted;
}

let toolInput = stdinData?.tool_input || stdinData?.toolInput || stdinData?.tool_args || stdinData?.toolArgs || null;
if (toolInput == null) {
  try { toolInput = JSON.parse(process.env.TOOL_INPUT || 'null'); } catch (_) { toolInput = process.env.TOOL_INPUT || null; }
}
let toolResult = stdinData?.tool_response     // VS Code 공식 필드명
              || stdinData?.tool_result || stdinData?.toolResult
              || stdinData?.tool_output || stdinData?.toolOutput || null;
if (toolResult == null) {
  try { toolResult = JSON.parse(process.env.TOOL_RESULT || 'null'); } catch (_) { toolResult = process.env.TOOL_RESULT || null; }
}

// ── 로그 엔트리 작성 ───────────────────────────────────────────
const entry = {
  ts:        new Date().toISOString(),
  session:   sessionId,
  agent:     agentName,
  tool:      toolName,
  input:     summarize(toolInput),
  result:    summarize(toolResult),
};

// ── 실패 감지 ────────────────────────────────────────────────────
function detectFailure(result) {
  if (!result) return false;
  if (result.isError === true || result.error === true) return true;
  const exitCode = result.exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) return true;
  const code = result.code;
  if (typeof code === 'number' && code !== 0) return true;
  // 문자열 패턴 감지 (raw 저장 없이)
  try {
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    if (/"is_error"\s*:\s*true/.test(str) || /"failed"\s*:\s*true/.test(str)) return true;
  } catch (_) {}
  return false;
}

function getFailureStatus(result) {
  if (!result) return 'error';
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return `exit:${result.exitCode}`;
  if (typeof result.code === 'number' && result.code !== 0) return `code:${result.code}`;
  return 'failed';
}

// redactHint: 실패 메타에서 힌트 정보 단순 redact
function redactHint(val) {
  if (!val) return '';
  const s = String(val).slice(0, 80);
  if (audit) { try { return audit.summarize(s, 80) || ''; } catch (_) {} }
  const re = new RegExp(SENSITIVE_RE.source, SENSITIVE_RE.flags);
  return s.replace(re, '[REDACTED]');
}

const isFailed = detectFailure(toolResult);
const failStatus = isFailed ? getFailureStatus(toolResult) : null;

// 실패 메타 기록
if (isFailed) {
  let inputHintRaw = '';
  if (toolInput && typeof toolInput === 'object') {
    inputHintRaw = toolInput.path || toolInput.filePath || toolInput.file_path
      || toolInput.command || toolInput.query || '';
  }
  const failEntry = {
    ts:        new Date().toISOString(),
    session:   sessionId,
    agent:     agentName,
    tool:      toolName,
    status:    failStatus,
    inputHint: redactHint(inputHintRaw),
  };
  try {
    fs.appendFileSync(
      path.join(logsDir, 'failure-meta.jsonl'),
      JSON.stringify(failEntry) + '\n',
      'utf8'
    );
  } catch (_) {}
}

const logFile = path.join(logsDir, 'pipeline.jsonl');
try {
  fs.appendFileSync(logFile, JSON.stringify({ ...entry, ok: !isFailed, status: failStatus || 'ok' }) + '\n', 'utf8');
} catch (_) {
  // 로그 실패는 무시 — 메인 파이프라인 블락하지 않음
}
tryAudit({ event: 'tool_decision', decision: isFailed ? 'failure' : 'record', tool: toolName, status: failStatus || 'ok', session: sessionId, agent: agentName });
_updateRecentTools(toolName);

// ── Heartbeat counter ─────────────────────────────────────────────
let heartbeatMsg = '';
try {
  const hbCounterFile = path.join(logsDir, 'heartbeat-counter.json');
  let count = 0;
  try {
    const hbc = JSON.parse(fs.readFileSync(hbCounterFile, 'utf8'));
    count = (typeof hbc.count === 'number' ? hbc.count : 0) + 1;
  } catch (_) { count = 1; }
  try {
    fs.writeFileSync(hbCounterFile, JSON.stringify({ count }), 'utf8');
  } catch (_) {}

  if (count % 10 === 0) {
    // 10회마다 상태 저장
    let todos = [];
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(logsDir, 'current-todos.json'), 'utf8'));
      todos = saved.todos || [];
    } catch (_) {}
    const inProgressTitles = todos.filter(t => t.status === 'in-progress').map(t => t.title);

    // 최근 5개 도구 이력 — recent-tools.json 링버퍼에서 읽기 (pipeline.jsonl 전체 read 불필요)
    let recentTools = [];
    try {
      const rt = JSON.parse(fs.readFileSync(path.join(logsDir, 'recent-tools.json'), 'utf8'));
      recentTools = (Array.isArray(rt.tools) ? rt.tools : []).slice(-5);
    } catch (_) {}

    const hbState = {
      ts:      new Date().toISOString(),
      session: sessionId,
      agent:   agentName,
      count,
      todos:   { count: todos.length, done: todos.filter(t => t.status === 'completed').length, inProgress: inProgressTitles },
      recentTools,
    };
    try {
      fs.writeFileSync(path.join(logsDir, 'heartbeat-state.json'), JSON.stringify(hbState, null, 2), 'utf8');
    } catch (_) {}

    heartbeatMsg = ' | 💓 checkpoint';
    tryAudit({ event: 'tool_decision', decision: 'heartbeat', count, tool: toolName, session: sessionId, agent: agentName });
  }
} catch (_) {}

// ── 사용자 가시 로그 ───────────────────────────────────────────
const icon = TOOL_ICON[toolName] || '🔧';
let inputHint = '';
if (toolInput && typeof toolInput === 'object') {
  const filePath = toolInput.path || toolInput.file_path || toolInput.filePath
    || toolInput.command || toolInput.query || '';
  if (filePath) {
    const re = new RegExp(SENSITIVE_RE.source, SENSITIVE_RE.flags);
    const safeHint = String(filePath).slice(0, 60).replace(re, '[REDACTED]');
    inputHint = ` → \`${safeHint}\``;
  }
}

let hookOutput = `${icon} [${agentName}] **${toolName}**${inputHint}`;
if (isFailed) {
  hookOutput = `❌ [${agentName}] ${toolName} 실패 (${failStatus})${inputHint ? ' → ' + inputHint.replace(/^ → `|`$/g, '') : ''}`;
}
hookOutput += heartbeatMsg;

process.stdout.write(JSON.stringify({
  continue: true,
  hookSpecificOutput: hookOutput,
}));
} // end main()

main().catch(() => {
  try { process.stdout.write(JSON.stringify({ continue: true })); } catch (_) {}
}).finally(() => process.exit(0));
