#!/usr/bin/env node
/**
 * retrospective-trigger.js
 * SubagentStop hook — 파이프라인 종료 시 실행 데이터를 draft JSON에 기록.
 * Terminal 에이전트(Reviewer, Planner, Release, Documenter, Investigator)가
 * 완료될 때 계획 vs 실제 실행을 비교하여 retrospective-draft.json을 쓴다.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const TERMINAL_AGENTS = new Set(['Reviewer', 'Planner', 'Release', 'Documenter', 'Investigator']);

const ACTION_TEMPLATES = {
  Tester:       'implement/fix 파이프라인에서 Tester 호출 필수 — 다음 Reviewer 호출 전 확인',
  Reviewer:     'Reviewer 승인 없이 파이프라인 종료 금지 — 재실행 필요',
  Planner:      'Planner 건너뜀 — 다음 실행 시 설계 검증 단계 추가',
  Investigator: 'fix 파이프라인 시작 전 Investigator 완료 필수',
  Documenter:   'Documenter 단계 누락 — 문서화 후속 작업 확인',
};

const HOOKS_DIR = path.resolve(__dirname, '..');
const LOGS_DIR  = path.join(HOOKS_DIR, '..', 'logs');
const DRAFT_PATH = path.join(LOGS_DIR, 'retrospective-draft.json');

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function safeWrite(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* fail-open */ }
}

function parseJsonLines(content) {
  if (!content) return [];
  return content.split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

(function main() {
  const agentName   = process.env.SUBAGENT_NAME || process.env.AGENT_NAME || '';
  const sessionId   = process.env.SESSION_ID    || process.env.COPILOT_SESSION_ID || '';

  if (!TERMINAL_AGENTS.has(agentName)) {
    process.exit(0); // 터미널 에이전트가 아니면 아무것도 안 함
  }

  // audit 로그에서 현재 세션의 final_pipeline 이벤트 찾기
  const auditRaw = safeRead(path.join(LOGS_DIR, 'hook-audit.jsonl'));
  const auditLines = parseJsonLines(auditRaw);

  // 가장 최근 final_pipeline 이벤트 (sessionId 매칭 시도, 없으면 마지막 것)
  const finalPipelineEvents = auditLines.filter(l => l.event === 'final_pipeline');
  let finalPipeline = null;
  if (sessionId) {
    finalPipeline = [...finalPipelineEvents].reverse().find(l => l.sessionId === sessionId);
  }
  if (!finalPipeline && finalPipelineEvents.length > 0) {
    finalPipeline = finalPipelineEvents[finalPipelineEvents.length - 1];
  }

  const plannedPipeline = finalPipeline?.pipeline || [];
  const intent          = finalPipeline?.intent   || 'unknown';
  const complexity      = finalPipeline?.complexity ?? null;

  // subagent-flow.jsonl에서 현재 세션 실행 이력 수집
  const flowRaw = safeRead(path.join(LOGS_DIR, 'subagent-flow.jsonl'));
  const flowLines = parseJsonLines(flowRaw);
  const sessionFlows = sessionId
    ? flowLines.filter(l => l.sessionId === sessionId)
    : flowLines.slice(-20); // 세션ID 없으면 최근 20개

  const executedAgents = [...new Set(
    sessionFlows
      .filter(l => l.event === 'subagent_stop' || l.event === 'stop')
      .map(l => l.agentName || l.agent)
      .filter(Boolean)
  )];

  // 건너뛴 에이전트 계산
  const skippedAgents = plannedPipeline.filter(a => !executedAgents.includes(a));

  // 총 소요 시간
  const starts = sessionFlows.filter(l => l.event === 'subagent_start' || l.event === 'start');
  const stops  = sessionFlows.filter(l => l.event === 'subagent_stop'  || l.event === 'stop');
  const firstStart = starts[0]?.ts ? new Date(starts[0].ts).getTime() : null;
  const lastStop   = stops[stops.length - 1]?.ts ? new Date(stops[stops.length - 1].ts).getTime() : null;
  const durationMs = (firstStart && lastStop) ? lastStop - firstStart : null;

  // 건너뛴 에이전트에 대한 actionItems 생성
  const actionItems = skippedAgents.map(a => ({
    source:  'skippedAgent',
    agent:   a,
    message: ACTION_TEMPLATES[a] || `${a} 에이전트 건너뜀 — 다음 실행 시 포함 확인`,
    ts:      new Date().toISOString(),
  }));

  const draft = {
    sessionId,
    ts: new Date().toISOString(),
    terminalAgent: agentName,
    intent,
    complexity,
    plannedPipeline,
    executedAgents,
    skippedAgents,
    durationMs,
    actionItems,
  };

  safeWrite(DRAFT_PATH, draft);

  // ── retrospective-history.md 자동 append ───────────────────────
  const HISTORY_PATH = path.join(LOGS_DIR, 'retrospective-history.md');

  try {
    // 마크다운 주입 방지: 줄바꿈 제거
    function sanitizeMd(val) {
      return String(val ?? '').replace(/[\r\n]+/g, ' ').trim();
    }

    const today       = new Date().toISOString().slice(0, 10);
    const intentLabel = sanitizeMd(draft.intent || 'unknown');
    const pipeline    = (draft.plannedPipeline || []).map(sanitizeMd).join('→');
    const executed    = (draft.executedAgents  || []).map(sanitizeMd).map(a => `${a} ✅`).join(' → ') || '(기록 없음)';
    const skipped     = (draft.skippedAgents   || []).map(sanitizeMd).join(', ') || '없음';
    const duration    = draft.durationMs ? `${Math.round(draft.durationMs / 1000)}s` : '?';

    const entry = [
      `\n---\n`,
      `## ${today} — ${intentLabel}: ${pipeline}\n`,
      `\n`,
      `| 항목 | 내용 |\n`,
      `|------|------|\n`,
      `| 실행 | ${executed} |\n`,
      `| 건너뜀 | ${skipped} |\n`,
      `| 소요 | ${duration} |\n`,
      `\n`,
      `**자기비평**: (Maestro 기입 필요)\n`,
      `**다음 번 개선**: (Maestro 기입 필요)\n`,
    ].join('');

    const HEADER = '# Maestro 회고 로그\n\n## 반복 패턴\n(없음)\n';
    const dupKey = `## ${today} — ${intentLabel}: ${pipeline}`;

    let existing = '';
    try { existing = fs.readFileSync(HISTORY_PATH, 'utf8'); } catch (_) {}

    if (!existing) {
      // 파일 없음: 헤더 + 첫 항목 동시 기록
      fs.writeFileSync(HISTORY_PATH, HEADER + entry, 'utf8');
    } else if (!existing.includes(dupKey)) {
      // 기존 파일에 중복 없으면 append
      fs.appendFileSync(HISTORY_PATH, entry, 'utf8');
    }
  } catch (_) {}
  // ────────────────────────────────────────────────────────────────

  // ── auto-tc-pending.json 생성 ─────────────────────────────────────
  const AUTO_TC_PATH = path.join(LOGS_DIR, 'auto-tc-pending.json');
  const TEST_FILE_PATH = path.join(process.cwd(), '.github', 'tests', 'maestro-suite.test.js');

  try {
    const { generatePendingTCs } = require('./tc-generator');
    const pendingTCs = generatePendingTCs(actionItems, TEST_FILE_PATH);
    if (pendingTCs.length > 0) {
      safeWrite(AUTO_TC_PATH, {
        generatedAt:     new Date().toISOString(),
        sourceSessionId: sessionId,
        pendingTCs,
      });
    } else {
      // stale 파일 제거
      try { fs.unlinkSync(AUTO_TC_PATH); } catch (_) {}
    }
  } catch (_) {}

  process.exit(0);
})();
