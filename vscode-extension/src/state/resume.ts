import * as fs from 'fs';
import { HarnessPaths } from './paths';

interface TodoItem {
  id?: number;
  title?: string;
  status?: string;
}

interface PrecompactState {
  ts?: string;
  agent?: string;
  todos?: { inProgress?: TodoItem[] };
  gitStatus?: string[];
  recentErrors?: Array<{ tool?: string; event?: string; status?: string; ts?: string }>;
}

export function loadSavedTodosBlock(paths: HarnessPaths): string {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.log('current-todos.json'), 'utf8'));
    const todos: TodoItem[] = Array.isArray(raw.todos) ? raw.todos : [];
    if (todos.length === 0) return '';
    const icon: Record<string, string> = { completed: 'PASS', 'in-progress': 'DOING', 'not-started': 'TODO' };
    const done = todos.filter(t => t.status === 'completed').length;
    return [
      `## [현재 Todo 상태] (${done}/${todos.length} 완료)`,
      ...todos.slice(0, 20).map(t => `- ${icon[t.status || ''] || '?'} ${t.title || '(title 없음)'}`),
    ].join('\n');
  } catch {
    return '';
  }
}

export function loadPrecompactBlock(paths: HarnessPaths): string {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.log('precompact-state.json'), 'utf8')) as PrecompactState;
    const lines = ['## [세션 재개 — 이전 상태]'];
    if (raw.ts) lines.push(`저장 시각: ${raw.ts}`);
    const inProgress = raw.todos?.inProgress || [];
    if (inProgress.length) {
      lines.push('### 진행 중 작업');
      for (const t of inProgress.slice(0, 5)) lines.push(`- ${t.title || '(title 없음)'}`);
    }
    const gitStatus = raw.gitStatus || [];
    if (gitStatus.length) {
      lines.push('### Git 변경');
      for (const g of gitStatus.slice(0, 5)) lines.push(`- ${g}`);
    }
    const recentErrors = raw.recentErrors || [];
    if (recentErrors.length) {
      lines.push('### 최근 오류');
      for (const e of recentErrors.slice(0, 5)) lines.push(`- ${e.event || e.tool || '?'} — ${e.status || '?'} (${e.ts || '?'})`);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  } catch {
    return '';
  }
}
