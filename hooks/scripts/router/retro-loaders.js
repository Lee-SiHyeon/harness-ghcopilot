'use strict';

const fs   = require('fs');
const path = require('path');

const { sanitizeForPrompt, wrapUntrusted } = require('./env-utils');

// ── 과거 회고 패턴 로드 ───────────────────────────────────────────
function loadRetrospectiveLearnings() {
  try {
    const logsDir = path.resolve(__dirname, '../../../logs');
    let block = '';

    // retro-patterns.json에서 반복 패턴 읽기
    const patternsPath = path.join(logsDir, 'retro-patterns.json');
    if (fs.existsSync(patternsPath)) {
      const patterns = JSON.parse(fs.readFileSync(patternsPath, 'utf8'));
      if (patterns.length) {
        const patternText = patterns.map(p => `- ${p.name}: ${p.count}회 / 개선: ${p.fix}`).join('\n');
        block += '\n반복 패턴:\n' + wrapUntrusted('retro', sanitizeForPrompt(patternText, 500)) + '\n';
      }
    }

    // retro.jsonl 최근 3개 nextImprovement
    const jsonlPath = path.join(logsDir, 'retro.jsonl');
    if (fs.existsSync(jsonlPath)) {
      const records = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')
        .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(r => r && r.nextImprovement && !r.nextImprovement.includes('기입 필요'));
      const recent = records.slice(-3).map(r => `- ${r.date}: ${r.nextImprovement}`).join('\n');
      if (recent) {
        block += '\n최근 개선 목표:\n' + wrapUntrusted('retro', sanitizeForPrompt(recent, 400)) + '\n';
      }
    }

    if (!block) return null;
    return '\n## [📚 과거 회고 패턴 — 이번 작업 시 유의]\n' + block;
  } catch { return null; }
}

// ── 미해결 actionItems 로드 ────────────────────────────────────────
function loadActionItems() {
  try {
    const draftPath = path.join(process.cwd(), '.github', 'logs', 'retrospective-draft.json');
    const raw = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
    const items = (raw.actionItems || []).filter(item =>
      item && typeof item.message === 'string'
    );
    if (items.length === 0) return null;
    const lines = ['## [⚠️ 미해결 개선 항목 — 이번 세션에서 처리 필요]'];
    items.forEach((item, i) => {
      const label = sanitizeForPrompt(item.agent || item.source || '?', 30);
      const msg   = sanitizeForPrompt(item.message, 150);
      lines.push(`${i + 1}. [${label}] ${msg}`);
    });
    lines.push('', '> 이 항목들을 fix 파이프라인으로 처리하거나 사용자에게 확인 후 진행한다.');
    lines.push('> 처리 완료 후 retrospective-draft.json의 actionItems를 빈 배열([])로 초기화한다.');

    // retroImprovement 소스 항목이 있으면 자기개선 루프 트리거 지시 추가
    const hasRetroImprovement = items.some(i => i.source === 'retroImprovement');
    if (hasRetroImprovement) {
      lines.push('');
      lines.push('## [🔄 자기개선 루프 트리거]');
      lines.push('회고 "다음 번 개선" 항목이 actionItem으로 변환되었습니다.');
      lines.push('Scout → Planner → Implementer → Tester → Reviewer → Critic → Release 파이프라인으로 처리하세요.');
      lines.push('처리 완료 후 반드시 retrospective-draft.json의 actionItems를 빈 배열([])로 초기화하세요.');
    }

    return lines.join('\n');
  } catch { return null; }
}

// ── actionItems 건수 조회 (📋 템플릿 동적 구성용) ─────────────────
function loadActionItemsCount() {
  try {
    const draftPath = path.join(process.cwd(), '.github', 'logs', 'retrospective-draft.json');
    const raw = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
    const items = (raw.actionItems || []).filter(item =>
      item && typeof item.message === 'string'
    );
    return items.length;
  } catch { return 0; }
}

module.exports = { loadRetrospectiveLearnings, loadActionItems, loadActionItemsCount };
