#!/usr/bin/env node
/**
 * precompact-save.js — PreCompact Hook
 *
 * 컨텍스트 압축(compaction) 직전에 실행.
 * 현재 세션의 중요 상태를 파일로 저장하고,
 * extraInstructions로 압축 요약본 안에 compact recovery summary를 임베드한다.
 *
 * PreCompact 훅의 특수 반환 필드:
 *   extraInstructions — 압축 후 요약본에 반드시 포함할 지시사항 (상태 복원용)
 *
 * 환경변수 (보안: SESSION_ID, AGENT_NAME만 사용. 비밀/토큰 값은 저장 안 함):
 *   SESSION_ID     세션 ID
 *   AGENT_NAME     현재 에이전트 이름
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { execFileSync } = require('child_process');

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

const NOW     = new Date().toISOString();
const SESSION = process.env.SESSION_ID || 'unknown';
const AGENT   = process.env.AGENT_NAME || 'unknown';
const CWD     = process.cwd();

const logsDir      = path.resolve(CWD, '.github', 'logs');
const templatesDir = path.resolve(CWD, '.github', 'templates');
try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}

// ── 1. 저장된 todo 상태 읽기 ─────────────────────────────────────
const todoFile = path.join(logsDir, 'current-todos.json');
let todos    = [];
let todosTs  = null;
try {
  const saved = JSON.parse(fs.readFileSync(todoFile, 'utf8'));
  todos   = saved.todos || [];
  todosTs = saved.ts    || null;
} catch (_) {}

const todosDone       = todos.filter(t => t.status === 'completed').length;
const todosInProgress = todos.filter(t => t.status === 'in-progress');

// ── 2. pipeline.jsonl 최근 이벤트 — PreCompact 자신 제외, 최대 10개 ──
const pipelineFile = path.join(logsDir, 'pipeline.jsonl');
let recentEvents   = [];
let recentErrors   = [];
try {
  const lines = fs.readFileSync(pipelineFile, 'utf8')
    .split('\n')
    .filter(l => l.trim());
  const parsed = lines
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(e => e && e.event !== 'PreCompact');

  // 최근 10개
  recentEvents = parsed.slice(-10).map(e => ({
    ts:    e.ts   || '?',
    event: e.event || e.tool || '?',
    agent: e.agent || e.agentName || undefined,
    ok:    e.ok   !== undefined ? e.ok : undefined,
  }));

  // 실패/에러 최근 5개 — 명시적 실패 필드만 검사 (경로명/도구명 오분류 방지)
  // 민감정보(stderr/detail/error body) 제외, 메타만 저장
  recentErrors = parsed
    .filter(e =>
      e.ok === false ||
      (typeof e.exitCode === 'number' && e.exitCode > 0) ||
      e.status === 'failed' ||
      e.isFailed === true ||
      (e.toolResult && e.toolResult.error)
    )
    .slice(-5)
    .map(e => ({
      ts:     e.ts     || '?',
      source: e.source || e.agent || undefined,
      tool:   e.tool   || undefined,
      event:  e.event  || e.tool || '?',
      status: (typeof e.exitCode === 'number' && e.exitCode > 0) ? `exit:${e.exitCode}` : 'failed',
    }));
} catch (_) {}

// ── 3. PLAN.md / IMPLEMENT.md 존재 여부 + 첫 줄(제목) ───────────────
function readHead(filePath, lines = 3) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').slice(0, lines).join(' ').slice(0, 120);
  } catch (_) { return null; }
}
const planFile   = path.join(templatesDir, 'PLAN.md');
const implFile   = path.join(templatesDir, 'IMPLEMENT.md');
const planHead   = readHead(planFile);
const implHead   = readHead(implFile);

// ── 4. git status --short (실패 시 무시) ──────────────────────────
let gitStatus = null;
try {
  const out = execFileSync('git', ['status', '--short'], {
    cwd:     CWD,
    timeout: 3000,
    encoding: 'utf8',
    stdio:   ['ignore', 'pipe', 'ignore'],
  });
  const lines = out.trim().split('\n').filter(l => l.trim()).slice(0, 10);
  if (lines.length > 0) gitStatus = lines;
} catch (_) {}

// ── 5. 상세 상태를 precompact-state.json에 저장 ─────────────────────
const stateObj = {
  ts:            NOW,
  session:       SESSION,
  agent:         AGENT,
  cwd:           CWD,
  todos: {
    count:       todos.length,
    done:        todosDone,
    inProgress:  todosInProgress.map(t => ({ id: t.id, title: t.title })),
    savedAt:     todosTs,
  },
  planTemplate:  planHead ? { exists: true, head: planHead } : { exists: false },
  implTemplate:  implHead ? { exists: true, head: implHead } : { exists: false },
  gitStatus:     gitStatus || [],
  recentEvents,
  recentErrors,
};
try {
  fs.writeFileSync(
    path.join(logsDir, 'precompact-state.json'),
    JSON.stringify(stateObj, null, 2),
    'utf8'
  );
} catch (_) {}

// ── 6. compaction-events.jsonl에 append ──────────────────────────
const compactEntry = {
  ts:          NOW,
  event:       'PreCompact',
  session:     SESSION,
  agent:       AGENT,
  todos_count: todos.length,
  todos_done:  todosDone,
  errors_seen: recentErrors.length,
  git_changes: gitStatus ? gitStatus.length : null,
};
try {
  fs.appendFileSync(
    path.join(logsDir, 'compaction-events.jsonl'),
    JSON.stringify(compactEntry) + '\n',
    'utf8'
  );
} catch (_) {}

// pipeline.jsonl에도 기록 (기존 동작 유지)
try {
  fs.appendFileSync(
    pipelineFile,
    JSON.stringify(compactEntry) + '\n',
    'utf8'
  );
} catch (_) {}

// ── 7. compact recovery summary — extraInstructions 구성 ────────
// 전체 로그 대신 핵심 요약만 임베드한다.
let extraInstructions = '';
try {
  const STATUS_ICON = { completed: '✅', 'in-progress': '🔄', 'not-started': '□' };
  const parts = ['## [압축 전 저장 상태 — 자동 복원]', `> 저장 시각: ${NOW}  |  세션: ${SESSION}  |  에이전트: ${AGENT}`];

  // Todo
  if (todos.length > 0) {
    parts.push(`\n### Todo (${todosDone}/${todos.length} 완료, 저장: ${todosTs || '알 수 없음'})`);
    for (const t of todos.slice(0, 10)) {
      parts.push(`- ${STATUS_ICON[t.status] || '?'} [${t.status}] ${t.title}`);
    }
    if (todos.length > 10) parts.push(`  … 외 ${todos.length - 10}개`);
  } else {
    parts.push('\n### Todo\n- (저장된 todo 없음)');
  }

  // in-progress 재개
  if (todosInProgress.length > 0) {
    parts.push('\n### 우선 재개 (in-progress)');
    for (const t of todosInProgress.slice(0, 5)) {
      parts.push(`- 🔄 ${t.title}${t.id ? `  (id: ${t.id})` : ''}`);
    }
  }

  // 변경 파일
  if (gitStatus && gitStatus.length > 0) {
    parts.push('\n### 변경 파일 (git status)');
    for (const l of gitStatus.slice(0, 8)) parts.push(`  ${l}`);
    if (gitStatus.length > 8) parts.push(`  … 외 ${gitStatus.length - 8}개`);
  }

  // 최근 tool 이벤트
  if (recentEvents.length > 0) {
    parts.push('\n### 최근 실행 이벤트 (최대 8개)');
    for (const e of recentEvents.slice(-8)) {
      const ok = e.ok === false ? ' ❌' : e.ok === true ? ' ✅' : '';
      parts.push(`- [${e.ts.slice(0, 19)}] ${e.event}${e.agent ? ` (${e.agent})` : ''}${ok}`);
    }
  }

  // 에러/실패 — 메타만 출력, stderr/detail 원문 제외
  if (recentErrors.length > 0) {
    parts.push('\n### 최근 실패/에러');
    for (const e of recentErrors.slice(0, 5)) {
      const tool = e.tool ? ` tool:${e.tool}` : '';
      parts.push(`- ⚠️ [${e.ts.slice(0, 19)}] ${e.event}${tool} (${e.status || 'error'})`);
    }
  }

  // PLAN/IMPLEMENT 템플릿
  if (planHead || implHead) {
    parts.push('\n### 계획/구현 템플릿');
    if (planHead) parts.push(`- PLAN.md: ${planHead}`);
    if (implHead) parts.push(`- IMPLEMENT.md: ${implHead}`);
    parts.push('- 마일스톤·결정·검증 게이트를 템플릿에서 확인하라.');
  }

  // 복원 지침
  parts.push(
    '',
    '### 복원 지침',
    '- 위 todo 목록을 manage_todo_list로 즉시 복원한다.',
    '- in-progress 항목부터 우선 재개한다.',
    '- 상세 상태: `.github/logs/precompact-state.json`',
    '- Todo 원본: `.github/logs/current-todos.json`',
    '- 전체 파이프라인: `.github/logs/pipeline.jsonl`',
    '- Compaction 이력: `.github/logs/compaction-events.jsonl`',
  );

  extraInstructions = parts.join('\n');
} catch (_) {}

try {
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: `💾 [PreCompact] Todo ${todosDone}/${todos.length} | 변경파일 ${gitStatus ? gitStatus.length : '?'} | 에러 ${recentErrors.length}`,
    extraInstructions,
  }));
  tryAudit({ event: 'precompact_save', session: SESSION, agent: AGENT, todoCount: todos.length, todoDone: todosDone, errorsSeen: recentErrors.length, gitChanges: gitStatus ? gitStatus.length : null });
} catch (_) {
  process.stdout.write('{"continue":true}');
}
