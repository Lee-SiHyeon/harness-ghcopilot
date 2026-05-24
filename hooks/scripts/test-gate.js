#!/usr/bin/env node
/**
 * test-gate.js — PostToolUse Test Evidence Gate Hook
 *
 * PostToolUse 단계에서 실행.
 * 채널 A: run_in_terminal 계열에서 테스트 명령 감지 → 결과 기록
 * 채널 B: manage_todo_list 완료 항목에서 테스트 증거 없으면 경고 (반복 억제)
 * 채널 C: 파일 변경 도구 감지 → requiredSince 갱신 (stale evidence 방지)
 *
 * 상태 파일: .github/logs/test-gate-state.json
 *   requiredSince         — 마지막 파일 변경 시각 (이 이후 PASS여야 유효)
 *   lastChangeAt          — 마지막 파일 변경 시각 (requiredSince와 동일)
 *   lastChangeTool        — 변경을 유발한 도구 이름
 *   warnedTodoKeys        — 이미 경고한 todo 키 목록 (반복 억제)
 *   lastWarnedStateSignature — 경고 당시 stale 상태 시그니처
 *
 * 입력: stdin JSON (hook 표준) 또는 환경변수 fallback
 *   TOOL_NAME, TOOL_INPUT, TOOL_RESULT, AGENT_NAME, SESSION_ID
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

// ── 민감정보 패턴 ─────────────────────────────────────────────────
const SENSITIVE_PATTERNS = [
  /password\s*[:=]\s*\S+/gi,
  /secret\s*[:=]\s*\S+/gi,
  /token\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /authorization\s*:[^\n]*/gi,              // Authorization header — full value (Bearer, Basic, etc.)
  /bearer\s+\S+/gi,                         // standalone Bearer token
  /https?:\/\/[^:@\s]+:[^@\s]+@\S+/gi,       // URL embedded credentials (https://user:pass@host)
  /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g,
];

function redact(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const pat of SENSITIVE_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

// ── 테스트 명령 감지 패턴 ─────────────────────────────────────────
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
  /\btap\b/i,
  /\bava\b/i,
  /\bnpx\s+(vitest|jest|mocha|tap|ava)\b/i,
  /\bpython\s+.*test/i,
  /\brunTests?\b/i,
];

// ── 완료 키워드 ────────────────────────────────────────────────────
const DONE_KEYWORDS = [
  '구현완료', '검증완료', '구현 완료', '검증 완료',
  'implementation complete', 'implementation done',
  'verification complete', 'verification done',
  'test complete', 'test done',
  '완료', 'completed', 'done', 'finish',
];

// ── 파일 변경 도구 세트 (채널 C) ──────────────────────────────────
// 이름은 normalize 후(소문자 + 특수문자 제거) 비교
const FILE_CHANGE_TOOLS = new Set([
  // Claude / generic
  'applypatch', 'editfile', 'createfile', 'deletefile',
  'renamefile', 'movefile', 'writefile',
  // VS Code Copilot
  'replacestringinfile', 'multireplacestringinfile',
  'inserteditintofile', 'editnotebookfile',
]);

// ── 로그 파일 경로 패턴 (채널 C 제외 대상) ────────────────────────
const LOG_FILE_RE = /\.github[\\/]logs[\\/]/;

function extractFilePaths(toolInput) {
  const candidates = [];
  // 단일 경로 필드
  for (const f of ['path', 'filePath', 'file_path', 'file', 'target', 'destination', 'newPath', 'oldPath']) {
    if (toolInput?.[f] && typeof toolInput[f] === 'string') candidates.push(toolInput[f]);
  }
  // multi_replace_string_in_file: replacements 배열
  if (Array.isArray(toolInput?.replacements)) {
    for (const r of toolInput.replacements) {
      if (r?.filePath && typeof r.filePath === 'string') candidates.push(r.filePath);
    }
  }
  return candidates;
}

function isExcludedFileChange(toolInput) {
  const paths = extractFilePaths(toolInput);
  // 경로 판별 불가 → 제외하지 않음 (변경으로 처리)
  if (paths.length === 0) return false;
  // 모든 경로가 로그 파일이면 제외
  return paths.every(p => LOG_FILE_RE.test(p));
}

// ── 경로 ──────────────────────────────────────────────────────────


// ── state-lib 위임 ─────────────────────────────────────────────────
const {
  getGateState,
  setGateState,
  recordEvidence: recordEvidenceLib,
  getEvidence,
} = require('../../mcp-server/state-lib/testgate.js');

// ── 상태 파일 읽기 / 쓰기 ─────────────────────────────────────────
function readState() {
  try { return getGateState(); }
  catch { return {}; }
}

function writeState(state) {
  try { setGateState(state); }
  catch { /* fail-open */ }
}

// ── 증거 파일 읽기 ────────────────────────────────────────────────
function readEvidence() {
  try { return getEvidence(); }
  catch { return null; }
}

// ── 증거 파일 쓰기 ────────────────────────────────────────────────
function writeEvidence(record) {
  try { recordEvidenceLib(record); }
  catch { /* fail-open: 기록 실패해도 훅은 계속 */ }
}

// ── 증거 유효성 확인 (PASS + 최신성) ─────────────────────────────
// PASS이고, requiredSince가 있으면 evidence.ts >= requiredSince 이어야 유효
// Date 객체 비교로 타임존 오프셋 혼재(예: +09:00 vs Z) 정확히 처리
function isEvidenceValid(evidence, state) {
  if (!evidence || evidence.result !== 'PASS') return false;
  if (!state || !state.requiredSince) return true; // 레거시: requiredSince 없으면 PASS는 유효
  const evidenceDate  = new Date(evidence.ts);
  const requiredDate  = new Date(state.requiredSince);
  // invalid date면 보수적 실패 처리
  if (isNaN(evidenceDate.getTime()) || isNaN(requiredDate.getTime())) return false;
  return evidenceDate >= requiredDate;
}

// ── 출력 마지막 N줄 추출 ──────────────────────────────────────────
function lastLines(text, n = 30) {
  if (!text) return '';
  const lines = String(text).split('\n');
  return lines.slice(-n).join('\n');
}

// ── PASS/FAIL 판단 ────────────────────────────────────────────────
function determineResult(toolResult, command) {
  const exitCode = toolResult?.exitCode ?? toolResult?.exit_code;
  const output   = String(toolResult?.output || toolResult?.stdout || toolResult?.result || '');

  // exit code 기반
  if (exitCode !== undefined && exitCode !== null) {
    const code = Number(exitCode);
    if (code === 0) return { passed: true, exitCode: code, output };
    return { passed: false, exitCode: code, output };
  }

  // 텍스트 기반 fallback
  const lowerOutput = output.toLowerCase();
  const failSignals = [
    /\bfailed\b/, /\berror\b/, /\bfailure\b/,
    /\d+\s+failed/, /tests\s+failed/i, /assertion\s+error/i,
  ];
  const passSignals = [
    /\bpassed\b/, /\ball.*pass/i, /✓/, /✔/, /ok$/im,
    /\d+\s+passed/, /tests\s+passed/i,
  ];

  const hasFail = failSignals.some(p => p.test(lowerOutput));
  const hasPass = passSignals.some(p => p.test(lowerOutput));

  if (hasFail && !hasPass) return { passed: false, exitCode: null, output };
  if (hasPass)             return { passed: true,  exitCode: null, output };

  // 판단 불가 → fail-safe
  return { passed: false, exitCode: null, output };
}

// ── 채널 A: 테스트 명령 처리 ─────────────────────────────────────
function handleTestCommand(toolInput, toolResult, agentName, sessionId) {
  const command = toolInput?.command || toolInput?.cmd || '';
  if (!TEST_CMD_PATTERNS.some(p => p.test(command))) return null;

  const { passed, exitCode, output } = determineResult(toolResult, command);
  const evidence = redact(lastLines(output, 30));

  // 통계 추출 (숫자 형식)
  const passMatch = output.match(/(\d+)\s*(pass(?:ed)?|test(?:s)?\s*pass(?:ed)?)/i);
  const failMatch = output.match(/(\d+)\s*(fail(?:ed)?|test(?:s)?\s*fail(?:ed)?)/i);

  const record = {
    ts:       new Date().toISOString(),
    session:  sessionId,
    agent:    agentName,
    tool:     'run_in_terminal',
    command:  redact(command),
    result:   passed ? 'PASS' : 'FAIL',
    exitCode: exitCode,
    passed:   passMatch ? Number(passMatch[1]) : null,
    failed:   failMatch ? Number(failMatch[1]) : null,
    evidence: evidence,
  };

  writeEvidence(record);

  tryAudit({ event: 'channel_a_test', tool: 'run_in_terminal', result: passed ? 'PASS' : 'FAIL', exitCode, command: redact(command).slice(0, 80), session: sessionId, agent: agentName });

  const msg = passed
    ? `✅ [TEST-GATE] 테스트 PASS — ${redact(command)}\n결과가 .github/logs/test-evidence.json에 기록되었습니다.`
    : `❌ [TEST-GATE] 테스트 FAIL — ${redact(command)}\nImplementer로 반환하여 수정 후 재테스트 하세요.`;

  return { continue: true, hookSpecificOutput: msg };
}

// ── 채널 B: 완료 todo 감시 ────────────────────────────────────────
function handleTodoDone(toolInput, toolResult, agentName, sessionId) {
  // manage_todo_list input/result 에서 completed 항목 추출 (input.todoList 우선)
  const items = toolInput?.todoList || toolInput?.todos || toolResult?.todos || toolResult?.items || [];
  if (!Array.isArray(items)) return null;

  const completedWithKeyword = items.filter(item => {
    if (item.status !== 'completed' && item.completed !== true) return false;
    const title = String(item.title || item.text || item.content || '').toLowerCase();
    return DONE_KEYWORDS.some(kw => title.includes(kw.toLowerCase()));
  });

  if (completedWithKeyword.length === 0) return null;

  const evidence = readEvidence();
  const state    = readState();

  // 유효한 증거 있으면 경고 불필요
  if (isEvidenceValid(evidence, state)) return null;

  // ── 반복 경고 억제 ────────────────────────────────────────────
  // stale 상태 시그니처: evidence.ts + requiredSince 조합
  const currentSig = `${evidence?.ts || 'null'}|${state.requiredSince || 'null'}`;
  const sameStaleSig = state.lastWarnedStateSignature === currentSig;

  const warnedKeys = new Set(Array.isArray(state.warnedTodoKeys) ? state.warnedTodoKeys : []);

  // 새로 경고해야 할 항목 (이미 같은 stale 상태에서 경고한 항목 제외)
  const toWarn = completedWithKeyword.filter(item => {
    const key = String(item.id || item.title || item.text || item.content || '').slice(0, 80);
    return !(sameStaleSig && warnedKeys.has(key));
  });

  if (toWarn.length === 0) return null; // 모두 이미 경고한 항목

  // 경고한 키 누적 저장
  for (const item of toWarn) {
    const key = String(item.id || item.title || item.text || item.content || '').slice(0, 80);
    warnedKeys.add(key);
  }
  writeState({
    ...state,
    warnedTodoKeys:           Array.from(warnedKeys),
    lastWarnedStateSignature: currentSig,
  });

  // stale PASS vs 아예 없음 구분 메시지
  // isEvidenceValid() 재사용: Date 객체 비교 (+09:00/Z 혼재 타임존 정확히 처리)
  const isStaleEvidence = !!(evidence && evidence.result === 'PASS' && state.requiredSince && !isEvidenceValid(evidence, state));
  const staleNote = isStaleEvidence
    ? `\n⚠️  stale PASS 감지: evidence.ts(${evidence.ts}) < requiredSince(${state.requiredSince})\n   파일 변경 이후 새 테스트가 필요합니다.`
    : '';

  tryAudit({ event: 'channel_b_todo_warn', items: toWarn.length, hasEvidence: !!(evidence && evidence.result === 'PASS'), isStale: isStaleEvidence, session: sessionId, agent: agentName });

  const warning =
    `⚠️ [TEST-GATE] 유효한 테스트 PASS 증거 없음 — "구현완료/검증완료" 표현 금지.${staleNote}\n` +
    `Tester 에이전트를 실행하여 테스트를 통과한 후 완료로 표시하세요.\n` +
    `증거 파일: .github/logs/test-evidence.json`;

  return { continue: true, hookSpecificOutput: warning };
}

// ── 채널 C: 파일 변경 도구 감지 → requiredSince 갱신 ─────────────
function handleFileChange(toolName, toolInput, agentName, sessionId) {
  // 로그 파일만 변경하는 경우 제외 (evidence/state 갱신은 테스트 필요 변경 아님)
  if (isExcludedFileChange(toolInput)) return null;

  const now   = new Date().toISOString();
  const state = readState();
  writeState({
    ...state,
    requiredSince:            now,
    lastChangeAt:             now,
    lastChangeTool:           toolName,
    // requiredSince 갱신 → 경고 억제 상태 리셋
    warnedTodoKeys:           [],
    lastWarnedStateSignature: null,
  });

  // file-change-log.jsonl 기록
  const changedPaths = extractFilePaths(toolInput);
  try {
    const logsDir = path.resolve(process.cwd(), '.github', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(
      path.join(logsDir, 'file-change-log.jsonl'),
      JSON.stringify({ ts: now, tool: toolName, paths: changedPaths.slice(0, 10), agent: agentName || null, session: sessionId || null }) + '\n',
      'utf8'
    );
  } catch (_) {}

  tryAudit({ event: 'channel_c_file_change', tool: toolName, paths: changedPaths.slice(0, 5), requiredSince: now, agent: agentName, session: sessionId });

  return null; // 채널 C는 hookSpecificOutput 없이 조용히 처리
}

// ── 환경변수 fallback 파싱 ────────────────────────────────────────
function parseEnvFallback() {
  let toolInput  = {};
  let toolResult = {};
  try { toolInput  = JSON.parse(process.env.TOOL_INPUT  || '{}'); } catch { toolInput  = {}; }
  try { toolResult = JSON.parse(process.env.TOOL_RESULT || '{}'); } catch { toolResult = {}; }
  return {
    toolName:  process.env.TOOL_NAME   || '',
    toolInput,
    toolResult,
    agentName: process.env.AGENT_NAME  || 'unknown',
    sessionId: process.env.SESSION_ID  || 'unknown',
  };
}

// ── 메인 ──────────────────────────────────────────────────────────
(async () => {
  let toolName   = '';
  let toolInput  = {};
  let toolResult = {};
  let agentName  = 'unknown';
  let sessionId  = 'unknown';

  // 도구 관련 환경변수가 있으면 stdin을 기다리지 않고 즉시 파싱
  // AGENT_NAME / SESSION_ID만 있는 경우는 stdin 경로 유지 (기능 손실 방지)
  const hasEnvInput = !!(
    process.env.TOOL_NAME   ||
    process.env.TOOL_INPUT  ||
    process.env.TOOL_RESULT
  );

  if (hasEnvInput) {
    // env 우선 경로: stdin 생략
    ({ toolName, toolInput, toolResult, agentName, sessionId } = parseEnvFallback());
  } else {
    // stdin JSON 파싱 시도 (훅 표준 경로)
    try {
      const MAX_STDIN_BYTES = 64 * 1024;
      const chunks = [];
      let total = 0;
      for await (const chunk of process.stdin) {
        total += chunk.length;
        if (total > MAX_STDIN_BYTES) break;
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        toolName   = parsed.tool_name   || parsed.toolName   || '';
        toolInput  = parsed.tool_input  || parsed.toolInput  || {};
        toolResult = parsed.tool_result || parsed.toolResult || {};
        agentName  = parsed.agent_name  || parsed.agentName  || 'unknown';
        sessionId  = parsed.session_id  || parsed.sessionId  || 'unknown';
      } else {
        // 빈 stdin → env fallback 시도
        ({ toolName, toolInput, toolResult, agentName, sessionId } = parseEnvFallback());
      }
    } catch {
      // stdin 파싱 실패 → env fallback
      ({ toolName, toolInput, toolResult, agentName, sessionId } = parseEnvFallback());
    }
  }

  // tool name normalize
  const normalizedTool = toolName.toLowerCase().replace(/[-_\s]/g, '');

  try {
    let response = null;

    // 채널 C: 파일 변경 도구 — requiredSince 갱신 (가장 먼저 처리)
    if (FILE_CHANGE_TOOLS.has(normalizedTool)) {
      response = handleFileChange(toolName, toolInput, agentName, sessionId);
    }

    // 채널 A: 터미널 실행 도구
    if (!response && ['runinterminal', 'executecommand', 'runinshell', 'bash', 'shell'].includes(normalizedTool)) {
      response = handleTestCommand(toolInput, toolResult, agentName, sessionId);
    }

    // 채널 B: todo 관리 도구
    if (!response && ['managetodolist', 'todoadd', 'todoupdate', 'todo'].includes(normalizedTool)) {
      response = handleTodoDone(toolInput, toolResult, agentName, sessionId);
    }

    // 기본 응답
    process.stdout.write(JSON.stringify(response || { continue: true }));
  } catch {
    // fail-open
    process.stdout.write(JSON.stringify({ continue: true }));
  }
})();
