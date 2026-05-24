'use strict';
/**
 * shared-utils.js — hooks/scripts 공용 헬퍼
 *
 * 여러 훅 스크립트가 중복 정의하던 판별 함수와 SSOT 로더를 단일 소스로 모아둔다.
 * 새 헬퍼 추가 시 반드시 module.exports에 함께 노출한다.
 */

const fs   = require('fs');
const path = require('path');

// V-new4: agent_id 자리에 들어온 값이 Anthropic Tool Call ID 패턴이면
// 실제 에이전트 이름이 아니므로 폐기해야 한다.
function isToolCallId(id) {
  return !!id && /^toolu_[a-zA-Z0-9_]+$/.test(id);
}

// ── guards.json SSOT 로더 ────────────────────────────────────────────
// JS와 PY guard가 공유하는 정적 데이터를 반환한다. 캐시되며 실패 시 빈 골격을 돌려준다.
let _guardsCache = null;
function loadGuards(filePath) {
  if (_guardsCache && !filePath) return _guardsCache;
  const resolved = filePath || path.resolve(__dirname, '..', '..', 'meta', 'guards.json');
  try {
    const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!filePath) _guardsCache = data;
    return data;
  } catch (_) {
    const fallback = {
      protectedDirs: [],
      protectedFiles: [],
      sensitiveExtensions: [],
      envFilenamePattern: '\\.env(\\.[a-z]+)?$',
      lockFiles: [],
      destructiveCommands: [],
    };
    if (!filePath) _guardsCache = fallback;
    return fallback;
  }
}

// destructiveCommands에서 lang에 적용되는 항목만 골라 {re, label} 배열로 컴파일.
function getDestructivePatterns(lang, guards) {
  const data = guards || loadGuards();
  const list = Array.isArray(data.destructiveCommands) ? data.destructiveCommands : [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry.regex !== 'string') continue;
    if (Array.isArray(entry.appliesTo) && !entry.appliesTo.includes(lang)) continue;
    try {
      out.push({ re: new RegExp(entry.regex, entry.flags || ''), label: entry.name || entry.regex });
    } catch (_) {
      // 잘못된 정규식은 건너뜀 (다른 언어용일 수 있음)
    }
  }
  return out;
}

module.exports = { isToolCallId, loadGuards, getDestructivePatterns };
