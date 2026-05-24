'use strict';

const fs   = require('fs');
const path = require('path');

const { sanitizeForPrompt, wrapUntrusted } = require('./env-utils');

// ── 저장된 todo 상태 읽기 (컨텍스트 압축 생존 보장) ─────────────
function loadSavedTodos() {
  try {
    const { getTodos } = require('../../../mcp-server/state-lib/todo.js');
    const raw = getTodos();
    const todos = raw.todos || [];
    if (todos.length === 0) return null;
    const STATUS_ICON = { 'completed': '✅', 'in-progress': '🔄', 'not-started': '□' };
    const lines = todos.map(t => `${STATUS_ICON[t.status] || '?'} ${sanitizeForPrompt(t.title, 100)}`).join('\n');
    const doneCount = todos.filter(t => t.status === 'completed').length;
    return `## [현재 Todo 상태] (${doneCount}/${todos.length} 완료 — 컨텍스트 압축 생존본)\n${lines}`;
  } catch (_) {
    return null;
  }
}

// ── precompact 상태 읽기 (세션 재개 감지) ────────────────────────
function loadPrecompactState() {
  const stateFile = path.resolve(process.cwd(), '.github', 'logs', 'precompact-state.json');
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const inProgress = (raw.todos && raw.todos.inProgress
      ? raw.todos.inProgress.slice(0, 5)
      : []);
    const gitStatus = (raw.gitStatus || []).slice(0, 3);
    const recentErrors = (raw.recentErrors || []).slice(0, 3).map(e => ({
      tool:   e.tool   || undefined,
      event:  e.event  || undefined,
      status: e.status || undefined,
      ts:     e.ts     || undefined,
    }));

    if (!inProgress.length && !recentErrors.length && !gitStatus.length) return null;

    return {
      ts:          raw.ts   || null,
      agent:       raw.agent || null,
      inProgress,
      gitStatus,
      recentErrors,
    };
  } catch (_) {
    return null;
  }
}

function formatResumeBlock(state) {
  if (!state) return null;
  const lines = ['## [세션 재개 — 이전 상태]'];
  if (state.ts) lines.push(`저장 시각: ${state.ts}`);
  if (state.inProgress.length) {
    lines.push('### 진행 중 작업');
    for (const t of state.inProgress) lines.push(`🔄 ${sanitizeForPrompt(t.title, 100)}`);
  }
  if (state.gitStatus.length) {
    lines.push('### Git 변경');
    lines.push(wrapUntrusted('git-status', state.gitStatus.map(g => sanitizeForPrompt(g, 120)).join('\n')));
  }
  if (state.recentErrors.length) {
    lines.push('### 최근 오류');
    for (const e of state.recentErrors) {
      const parts = [sanitizeForPrompt(e.event || e.tool || '?', 60), sanitizeForPrompt(e.status || '', 40)].filter(Boolean);
      lines.push(`  ❌ ${parts.join(' — ')} (${sanitizeForPrompt(e.ts || '?', 30)})`);
    }
  }
  return lines.join('\n');
}

module.exports = { loadSavedTodos, loadPrecompactState, formatResumeBlock };
