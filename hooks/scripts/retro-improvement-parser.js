#!/usr/bin/env node
/**
 * retro-improvement-parser.js — PostToolUse 훅
 *
 * retrospective-history.md가 수정될 때 "다음 번 개선:" 항목을
 * retrospective-draft.json의 actionItems로 자동 변환한다.
 *
 * 환경변수 (훅 실행 시):
 *   TOOL_NAME   실행된 도구 이름
 *   TOOL_INPUT  도구 입력 (JSON 문자열)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── 이중 방어 1: 파일 수정 도구인지 확인 ─────────────────────────
const WRITE_TOOLS = new Set([
  'edit_file', 'write_file', 'replace_string_in_file',
  'insert_edit_into_file', 'create_file',
]);

const toolName = process.env.TOOL_NAME || '';
if (!WRITE_TOOLS.has(toolName)) process.exit(0);

// ── 이중 방어 2: 대상 파일이 retrospective-history.md인지 확인 ───
// Windows(\) / POSIX(/) 양방향 경로 구분자 지원
let toolInput = {};
try { toolInput = JSON.parse(process.env.TOOL_INPUT || '{}'); } catch (_) {}

const filePath = toolInput.filePath || toolInput.path || toolInput.file_path || '';
// basename 추출: 슬래시/백슬래시 양방향 처리
const basename = filePath.replace(/\\/g, '/').split('/').pop() || '';
if (basename !== 'retrospective-history.md') process.exit(0);

// ── 메인 처리 (fail-open: 에러 시 exit(0)) ───────────────────────
try {
  const logsDir = path.resolve(process.cwd(), '.github', 'logs');
  const retroPath  = path.join(logsDir, 'retrospective-history.md');
  const draftPath  = path.join(logsDir, 'retrospective-draft.json');

  // retrospective-history.md 전체 읽기
  let content = '';
  try { content = fs.readFileSync(retroPath, 'utf8'); } catch (_) { process.exit(0); }

  // "**다음 번 개선**: ..." 항목 파싱
  const RE_IMPROVEMENT = /\*\*다음 번 개선\*\*:\s*(.+)/g;
  const found = [];
  let m;
  while ((m = RE_IMPROVEMENT.exec(content)) !== null) {
    const text = m[1].trim();
    // placeholder 필터: "(Maestro 기입 필요)" 포함 라인 제외
    if (!text || text.includes('(Maestro 기입 필요)')) continue;
    found.push(text);
  }

  if (found.length === 0) process.exit(0);

  // retrospective-draft.json 로드 (없으면 빈 구조)
  let draft = { actionItems: [] };
  try { draft = JSON.parse(fs.readFileSync(draftPath, 'utf8')); } catch (_) {}
  if (!Array.isArray(draft.actionItems)) draft.actionItems = [];

  // dedup 후 신규 항목만 추가
  const existingMessages = new Set(
    draft.actionItems
      .filter(i => i && i.source === 'retroImprovement')
      .map(i => i.message),
  );

  let added = 0;
  for (const text of found.slice(0, 50)) {
    if (!existingMessages.has(text)) {
      draft.actionItems.push({
        source: 'retroImprovement',
        message: text,
        ts: new Date().toISOString(),
      });
      existingMessages.add(text);
      added++;
    }
  }

  if (added > 0) {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2), 'utf8');
  }
} catch (_) {
  // fail-open: 에러 무시
}

process.exit(0);
