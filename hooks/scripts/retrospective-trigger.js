#!/usr/bin/env node
// Requires Node.js >= 18 (Array.prototype.findLastIndex)
/**
 * retrospective-trigger.js
 * SubagentStop hook — 파이프라인 종료 시 실행 데이터를 draft JSON에 기록.
 * Terminal 에이전트(Reviewer, Planner, Release, Documenter, Investigator)가
 * 완료될 때 계획 vs 실제 실행을 비교하여 retrospective-draft.json을 쓴다.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// G6: Maestro 포함 — @Maestro 에이전트 세션 종료 시에도 회고 트리거
const TERMINAL_AGENTS = new Set(['Reviewer', 'Planner', 'Release', 'Documenter', 'Investigator', 'Maestro']);

// G3: Release 키 추가 — Release 건너뜀 시 전용 메시지 생성
const ACTION_TEMPLATES = {
  Tester:       'implement/fix 파이프라인에서 Tester 호출 필수 — 다음 Reviewer 호출 전 확인',
  Reviewer:     'Reviewer 승인 없이 파이프라인 종료 금지 — 재실행 필요',
  Planner:      'Planner 건너뜀 — 다음 실행 시 설계 검증 단계 추가',
  Investigator: 'fix 파이프라인 시작 전 Investigator 완료 필수',
  Documenter:   'Documenter 단계 누락 — 문서화 후속 작업 확인',
  Release:      'Release 단계 누락 — 변경 사항 미커밋. 다음 실행 시 Release 포함 필수',
};

const HOOKS_DIR  = path.resolve(__dirname, '..');
const LOGS_DIR   = path.join(HOOKS_DIR, '..', 'logs');
const DRAFT_PATH = path.join(LOGS_DIR, 'retrospective-draft.json');
const JSONL_PATH = path.join(LOGS_DIR, 'retro.jsonl');

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

/**
 * 의미 있는 개선 항목인지 판별 (placeholder/빈값 제거).
 */
function isMeaningfulImprovement(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized.includes('기입 필요')) return false;
  const placeholders = new Set(['없음', '없음.', '해당 없음', '-', 'n/a']);
  return !placeholders.has(normalized);
}

/**
 * 세 소스의 actionItems를 message 기준 중복 제거 후 병합.
 * 순서: 기존(보존 우선) → 신규 skipped/violation → retroImprovement
 */
function mergeActionItems(existingItems, newItems, retroItems) {
  const seenMsgs = new Set();
  const result = [];
  for (const item of [...existingItems, ...newItems, ...retroItems]) {
    if (item && typeof item.message === 'string' && !seenMsgs.has(item.message)) {
      seenMsgs.add(item.message);
      result.push(item);
    }
  }
  return result;
}

/**
 * H-3·H-4 감지 — 부재 에이전트 기반 actionItem 생성.
 * @param {string} intent - 'implement' | 'fix' | 'plan' | ...
 * @param {string[]} executedAgents - 실행된 에이전트 이름 배열
 * @param {Array<{event:string, agentName?:string, agent?:string}>} sessionFlows - subagent-flow 로그 항목
 * @returns {Array<{source:string, agent:string, message:string, ts:string}>}
 */
function detectAbsentAgentItems(intent, executedAgents, sessionFlows) {
  const items = [];
  const ts = new Date().toISOString();

  // H-3: implement/fix 파이프라인에서 Tester 미실행 감지
  if (intent === 'implement' || intent === 'fix') {
    if (!executedAgents.includes('Tester')) {
      items.push({
        source:  'absentAgent',
        agent:   'Tester',
        message: ACTION_TEMPLATES.Tester,
        ts,
      });
    }
  }
  // H-3: Critic 미실행 감지 (intent 무관)
  if (!executedAgents.includes('Critic')) {
    items.push({
      source:  'absentAgent',
      agent:   'Critic',
      message: 'Critic 미실행 — 파이프라인 준수 감사 없이 종료됨. 다음 실행 시 Critic 포함 필수',
      ts,
    });
  }

  // H-4: Implementer 다중 실행 후 Reviewer 재확인 없음 감지
  const stopsOrdered = sessionFlows.filter(l =>
    l.event === 'subagent_stop' || l.event === 'stop' || l.event === 'SubagentStop'
  );
  const implCount = stopsOrdered.filter(l =>
    (l.agentName || l.agent) === 'Implementer'
  ).length;
  if (implCount >= 2) {
    const lastImplIdx = stopsOrdered.findLastIndex(l =>
      (l.agentName || l.agent) === 'Implementer'
    );
    const reviewerAfter = stopsOrdered.slice(lastImplIdx + 1).some(l =>
      (l.agentName || l.agent) === 'Reviewer'
    );
    if (!reviewerAfter) {
      items.push({
        source:  'implReviewGap',
        agent:   'Reviewer',
        message: 'Implementer ≥2회 실행 후 Reviewer 재확인 없음 — 다음 실행 시 Reviewer 재호출 필수',
        ts,
      });
    }
  }

  return items;
}

if (require.main === module) { (function main() {
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
      .filter(l => l.event === 'subagent_stop' || l.event === 'stop' || l.event === 'SubagentStop')
      .map(l => l.agentName || l.agent)
      .filter(Boolean)
  )];

  // 건너뛴 에이전트 계산
  const skippedAgents = plannedPipeline.filter(a => !executedAgents.includes(a));

  // 총 소요 시간
  const starts = sessionFlows.filter(l => l.event === 'subagent_start' || l.event === 'start' || l.event === 'SubagentStart');
  const stops  = sessionFlows.filter(l => l.event === 'subagent_stop'  || l.event === 'stop'  || l.event === 'SubagentStop');
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

  // maestro_direct_impl 위반 자동 기록 (최근 10분 이내 audit 항목)
  const MAESTRO_IMPL_WINDOW = 600000; // 10분 (ms)
  const now = Date.now();
  const maestroViolations = auditLines.filter(l =>
    l.reason === 'maestro_direct_impl' &&
    l.ts && (now - new Date(l.ts).getTime()) <= MAESTRO_IMPL_WINDOW &&
    (!sessionId || l.sessionId === sessionId)
  );
  for (const v of maestroViolations) {
    actionItems.push({
      source:  'maestroDirectImpl',
      agent:   v.agent || 'Maestro',
      message: `Maestro가 직접 파일 수정 시도 — Implementer 위임 필수 (${v.path || '?'})`,
      ts:      v.ts || new Date().toISOString(),
    });
  }

  const absentItems = detectAbsentAgentItems(intent, executedAgents, sessionFlows);
  actionItems.push(...absentItems);

  // ── 기존 draft.actionItems 보존 + retro.jsonl → retroImprovement 변환 ─────
  let existingActionItems = [];
  try {
    const existingDraft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
    if (Array.isArray(existingDraft.actionItems)) {
      existingActionItems = existingDraft.actionItems.filter(
        item => item && typeof item.message === 'string'
      );
    }
  } catch (_) {}

  // 마지막 retro 레코드 1개만 확인 (과거 전체 retro.jsonl 재처리 금지)
  const retroImprovements = [];
  try {
    const retroRaw = safeRead(JSONL_PATH);
    if (retroRaw) {
      const retroLines = retroRaw.trim().split('\n').filter(Boolean);
      if (retroLines.length > 0) {
        let lastRecord = null;
        try { lastRecord = JSON.parse(retroLines[retroLines.length - 1]); } catch { /* skip */ }
        if (lastRecord) {
          const text = lastRecord.nextImprovement ? lastRecord.nextImprovement.trim() : '';
          if (isMeaningfulImprovement(text)) {
            retroImprovements.push({
              source:  'retroImprovement',
              agent:   'Maestro',
              message: text,
              ts:      lastRecord.ts || new Date().toISOString(),
            });
          }
        }
      }
    }
  } catch (_) {}

  const mergedActionItems = mergeActionItems(existingActionItems, actionItems, retroImprovements);

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
    actionItems: mergedActionItems,
  };

  safeWrite(DRAFT_PATH, draft);

  // ── retro.jsonl 자동 append + markdown 재생성 ────────────────────

  try {
    function sanitizeMd(val) {
      return String(val ?? '').replace(/[\r\n]+/g, ' ').trim();
    }

    const today       = new Date().toISOString().slice(0, 10);
    const intentLabel = sanitizeMd(draft.intent || 'unknown');
    const pipelineStr = (draft.plannedPipeline || []).map(sanitizeMd).join('→');
    const executed    = (draft.executedAgents  || []).map(sanitizeMd).map(a => `${a} ✅`).join(' → ') || '(기록 없음)';
    const skipped     = (draft.skippedAgents   || []).map(sanitizeMd).join(', ') || '없음';

    // dedup 체크 (date+title 조합)
    const dupKey = `${today}|${intentLabel}`;
    let isDup = false;
    if (fs.existsSync(JSONL_PATH)) {
      const existing = fs.readFileSync(JSONL_PATH, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of existing) {
        try {
          const r = JSON.parse(line);
          if (r.date === today && r.title === intentLabel) { isDup = true; break; }
        } catch { /* skip */ }
      }
    }

    if (!isDup) {
      const record = {
        v:               1,
        date:            today,
        title:           intentLabel,
        type:            intentLabel || 'unknown',
        pipeline:        pipelineStr,
        executed,
        skipped,
        repeatIssue:     '',
        selfCritique:    '(Maestro 기입 필요)',
        nextImprovement: '(Maestro 기입 필요)',
        ts:              new Date().toISOString(),
        sessionId:       sessionId || process.env.SESSION_ID || '',
      };
      fs.mkdirSync(path.dirname(JSONL_PATH), { recursive: true });
      fs.appendFileSync(JSONL_PATH, JSON.stringify(record) + '\n', 'utf8');

      // markdown 재생성
      try {
        require('./retro-renderer').render(LOGS_DIR);
      } catch (_) {}
    }
  } catch (_) {}
  // ────────────────────────────────────────────────────────────────

  // ── auto-tc-pending.json 생성 ─────────────────────────────────────
  const AUTO_TC_PATH = path.join(LOGS_DIR, 'auto-tc-pending.json');
  const TEST_FILE_PATH = path.join(process.cwd(), '.github', 'tests', 'maestro-suite.test.js');

  try {
    const { generatePendingTCs } = require('./tc-generator');
    // retroImprovement source는 generatePendingTCs에서 제외 (prompt injection 방지)
    const tcActionItems = mergedActionItems.filter(i => i.source !== 'retroImprovement');
    const pendingTCs = generatePendingTCs(tcActionItems, TEST_FILE_PATH);
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
})(); }

module.exports = { isMeaningfulImprovement, mergeActionItems, detectAbsentAgentItems };
