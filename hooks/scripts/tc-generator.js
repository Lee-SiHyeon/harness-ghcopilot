'use strict';

const fs   = require('fs');
const path = require('path');

// 에이전트별 TC 템플릿
const AGENT_TC_TEMPLATES = {
  Tester: {
    group: 'maestro.agent.md / tester-required',
    desc:  'Tester 건너뜀 이력 → Tester FAIL 처리 규칙 문구 존재',
    code:  `() => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('Tester FAIL 처리 규칙')) throw new Error('Tester FAIL 처리 규칙 섹션 없음');
  if (!/Tester\\s*↔\\s*Implementer/.test(src)) throw new Error('Tester ↔ Implementer 순환 규칙 없음');
}`,
  },
  Reviewer: {
    group: 'maestro.agent.md / reviewer-required',
    desc:  'Reviewer 건너뜀 이력 → Reviewer 반복 종료 조건 문구 존재',
    code:  `() => {
  const src = readAgent('maestro.agent.md');
  if (!/반복 종료 조건/.test(src)) throw new Error('반복 종료 조건 문구 없음');
  if (!src.includes('Reviewer')) throw new Error('Reviewer 문구 없음');
}`,
  },
  Planner: {
    group: 'maestro.agent.md / planner-required',
    desc:  'Planner 건너뜀 이력 → Planner→Implementer 파이프라인 문구 존재',
    code:  `() => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('Planner')) throw new Error('Planner 문구 없음');
  if (!src.includes('Implementer')) throw new Error('Implementer 문구 없음');
}`,
  },
  Investigator: {
    group: 'maestro.agent.md / investigator-required',
    desc:  'Investigator 건너뜀 이력 → fix 파이프라인 Investigator 문구 존재',
    code:  `() => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('Investigator')) throw new Error('Investigator 문구 없음');
  if (!src.includes('fix')) throw new Error('fix 파이프라인 문구 없음');
}`,
  },
  Documenter: {
    group: 'maestro.agent.md / documenter-required',
    desc:  'Documenter 건너뜀 이력 → 문서화 파이프라인 Documenter 문구 존재',
    code:  `() => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('Documenter')) throw new Error('Documenter 문구 없음');
}`,
  },
};

/**
 * maestro-suite.test.js에서 이미 등록된 AUTO-TC dedupe 키 목록 반환
 */
function getExistingDedupeKeys(testFilePath) {
  try {
    const src = fs.readFileSync(testFilePath, 'utf8');
    const keys = [];
    for (const m of src.matchAll(/\/\/ AUTO-TC dedupe:([^\n]+)/g)) {
      keys.push(m[1].trim());
    }
    return new Set(keys);
  } catch (_) {
    return new Set();
  }
}

/**
 * 현재 최대 TC ID 반환
 */
function getMaxTcId(testFilePath) {
  try {
    const src = fs.readFileSync(testFilePath, 'utf8');
    const ids = [...src.matchAll(/tc\('tc-(\d+)'/g)].map(m => parseInt(m[1], 10));
    return ids.length > 0 ? Math.max(...ids) : 56;
  } catch (_) {
    return 56;
  }
}

/**
 * actionItems → pendingTC 배열 생성 (중복 제거 포함)
 * @param {Array} actionItems
 * @param {string} testFilePath - maestro-suite.test.js 경로
 * @returns {Array} pendingTCs
 */
function generatePendingTCs(actionItems, testFilePath) {
  const existing = getExistingDedupeKeys(testFilePath);
  const pendingTCs = [];
  const seen = new Set(existing);

  for (const item of (actionItems || [])) {
    const agent = item.agent || item.source || '';
    const dedupeKey = `skippedAgent:${agent}`;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const tpl = AGENT_TC_TEMPLATES[agent];
    if (!tpl) continue;  // 알 수 없는 에이전트 — 안전을 위해 TC 생성 건너뜀

    pendingTCs.push({
      dedupeKey,
      group:      tpl.group,
      desc:       tpl.desc,
      code:       tpl.code,
      actionItem: item,
    });
  }

  return pendingTCs;
}

module.exports = { generatePendingTCs, getExistingDedupeKeys, getMaxTcId };
