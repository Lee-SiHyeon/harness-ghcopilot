'use strict';

const { loadSavedTodos, loadPrecompactState, formatResumeBlock } = require('./state-loaders');
const { isScoutLoopPrompt, SCOUT_RALPH_PROTOCOL_BLOCK } = require('./classifier');
const { wrapUntrusted } = require('./env-utils');

const CONTEXT7_AGENT = 'Context7 Docs Agent';

// 라이브러리/프레임워크 감지 시 Context7을 파이프라인 첫 단계로 prepend.
// 이미 포함돼 있으면 그대로 둔다 (회귀 retro 2026-05-24 question 유형 대응).
function ensureContext7InPipeline(pipeline, stacks) {
  if (!Array.isArray(stacks) || stacks.length === 0) return pipeline;
  if (!Array.isArray(pipeline)) return pipeline;
  if (pipeline.includes(CONTEXT7_AGENT)) return pipeline;
  return [CONTEXT7_AGENT, ...pipeline];
}

// 라이브러리 감지 시 Maestro가 Context7을 건너뛰지 못하도록 강조 블록 추가.
function buildContext7EnforcementBlock(stacks) {
  if (!Array.isArray(stacks) || stacks.length === 0) return '';
  return [
    '## [⚠️ 라이브러리 감지 — Context7 호출 필수]',
    `- 감지된 스택: **${stacks.join(', ')}**`,
    '- 답변·구현·계획 전에 Context7 Docs Agent로 위 라이브러리의 최신 공식 문서를 반드시 조회한다.',
    '- 단순 질의(question/query)라도 라이브러리 관련이면 Context7을 거쳐야 한다 (직접 답변 금지).',
    '- 학습 데이터의 옛 API로 추측하는 것은 허용되지 않는다.',
  ].join('\n');
}

function formatPipeline(pipeline) {
  return Array.isArray(pipeline) && pipeline.length > 0
    ? pipeline.join(' → ')
    : '미정';
}

function buildDisclosureLines(analysis, source) {
  const lines = [
    `🎯 **작업 유형**: ${analysis.intent}`,
    `📋 **파이프라인**: ${formatPipeline(analysis.pipeline)}`,
  ];
  if (source) lines.push(`🔍 **분류 방식**: ${source}`);
  return lines;
}

function buildDisclosureHeader(analysis, source) {
  return [
    '## [⚠️ 필수 — 응답 첫 줄 출력 의무]',
    '아래 블록을 **응답의 첫 줄로** 반드시 출력한다. 단순 질문·짧은 답변도 예외 없음.',
    '```',
    ...buildDisclosureLines(analysis, source),
    '```',
    '이 블록 없이 내용을 출력하거나 에이전트를 호출하면 규칙 위반이다.',
  ].join('\n');
}

function buildUserMessage(analysis, parts, source) {
  return [buildDisclosureHeader(analysis, source), ...parts].filter(Boolean).join('\n\n');
}

function buildOriginalRequestBlock(prompt) {
  return ['## [원본 요청]', wrapUntrusted('user-request', prompt)].join('\n');
}

// ══════════════════════════════════════════════════════════════════
// 출력 빌더
// ctx: { prompt, MODEL, audit, tryAudit }
// ══════════════════════════════════════════════════════════════════
function buildOutput(analysis, usedLLM, ctx) {
  const { prompt = '', MODEL = '', audit = null, tryAudit = () => {} } = ctx || {};
  const { intent, complexity, scope, security, stacks,
          task_count, reason } = analysis;
  let { pipeline, needs_todo } = analysis;

  // 라이브러리 감지 시 Context7 강제 주입 (회귀: question 유형 Context7 건너뜀)
  pipeline = ensureContext7InPipeline(pipeline, stacks);
  analysis.pipeline = pipeline;
  const context7Block = buildContext7EnforcementBlock(stacks);

  const source = usedLLM ? `🤖 LLM(${MODEL})` : '⚙️ regex폴백';
  const routingComplexity = intent === 'scout_loop' ? Math.max(complexity, 6) : complexity;
  const routingNeedsTodo = needs_todo || intent === 'scout_loop';

  // 단순 요청 — 라우팅 정보만 표시하고 패스스루
  if (routingComplexity < 3) {
    const simpleParts = [];
    if (context7Block) simpleParts.push(context7Block);
    simpleParts.push(buildOriginalRequestBlock(prompt));
    return {
      continue: true,
      hookSpecificOutput: `💬 [Maestro] \`${intent}\` (${source} | 복잡도: ${routingComplexity}/10) — ${reason}`,
      modifiedParameters: { userMessage: buildUserMessage(analysis, simpleParts, source) },
    };
  }

  // ── HITL gate: 복잡도 8+ 또는 보안 민감 → 사용자 확인 요청 ──
  const isHighRisk = routingComplexity >= 8 || (security.length > 0 && routingComplexity >= 6);
  if (isHighRisk) {
    const secNote = security.length
      ? `\n- 보안 플래그: **${security.join(', ')}** 감지`
      : '';
    const promptSummary = audit ? audit.summarize(prompt, 100) : prompt.slice(0, 100);
    tryAudit({ event: 'hitl_gate', source: 'UserPromptSubmit', complexity, security, pipeline, scope, usedLLM, promptSummary });
    return {
      continue: false,
      decision: 'ask',
      reason: [
        ...buildDisclosureLines(analysis, source),
        '',
        `⚠️ **고위험 작업 감지** (복잡도: ${routingComplexity}/10)`,
        `- 파이프라인: ${pipeline.join(' → ')}`,
        `- 범위: ${scope}${secNote}`,
        `- 판단: ${reason}`,
        '',
        '이 작업을 진행하시겠습니까? 계속하려면 "진행해줘"라고 입력하세요.',
      ].join('\n'),
    };
  }

  // ── 시간예산 추정 ──────────────────────────────────────────────
  const timePerAgent = { Planner: 1, Investigator: 2, Implementer: 2, Tester: 2, Reviewer: 1, Documenter: 2, 'Context7 Docs Agent': 1, Release: 3, Critic: 1, Scout: 4 };
  const estMinutes = pipeline.reduce((sum, a) => sum + (timePerAgent[a] || 1), 0) * task_count;
  const timeBudget = `⏱ 예상 소요: ~${estMinutes}분 (에이전트 ${pipeline.length}개 × 작업 ~${task_count}개)`;

  const todoBlock = routingNeedsTodo ? [
    '## [필수] 작업 시작 전 todo 계획 수립',
    '반드시 다음 순서를 지킨다:',
    '1. `todo` 도구로 할 일 목록을 **먼저** 생성한다.',
    '2. 각 항목을 `in-progress`로 변경한 뒤 작업을 시작한다.',
    '3. 완료 즉시 `completed`로 표시한다.',
    '4. 모든 작업 완료 후 todo 목록을 최종 확인한다.',
    '5. implement/fix 파이프라인은 Tester를 Reviewer 직전 독립 todo 항목으로 반드시 추가한다.',
    '6. **마지막 todo는 반드시 Critic 호출** — H1~H6 파이프라인 준수 검증. Critic PASS 전까지 파이프라인 종료 불가.',
    '',
    '> todo 없이 `edit` / `execute` 도구를 사용하는 것은 허용되지 않는다.',
  ].join('\n') : null;

  const statusLine = [
    `**${complexity >= 6 ? '⚙️ Maestro 파이프라인 활성화' : '💡 Maestro 제안'}**`,
    `(${source} | 복잡도: ${routingComplexity}/10)`,
    `\n- 의도: \`${intent}\` | 범위: \`${scope}\` | 작업 수: ~${task_count}`,
    `\n- 파이프라인: ${pipeline.join(' → ')}`,
    `\n- ${timeBudget}`,
    security.length ? `\n- 보안: ${security.join(', ')}` : '',
    stacks.length   ? `\n- 스택: ${stacks.join(', ')}` : '',
    `\n- 판단 이유: ${reason}`,
  ].filter(Boolean).join('');

  // 중간 복잡도 (3~5): todo 주입 + 제안
  if (routingComplexity < 6) {
    const savedTodos  = loadSavedTodos();
    const resumeBlock = formatResumeBlock(loadPrecompactState());
    const parts = [];
    if (context7Block) parts.push(context7Block);
    if (intent === 'scout_loop') parts.push(SCOUT_RALPH_PROTOCOL_BLOCK);
    if (resumeBlock) parts.push(resumeBlock);
    if (savedTodos) parts.push(savedTodos);
    if (todoBlock) parts.push(todoBlock);
    parts.push(buildOriginalRequestBlock(prompt));
    return {
      continue: true,
      hookSpecificOutput: statusLine,
      modifiedParameters: { userMessage: buildUserMessage(analysis, parts, source) },
    };
  }

  // 고복잡도 (≥6): 오케스트레이션 컨텍스트 + todo 강제
  const savedTodos  = loadSavedTodos();
  const resumeBlock = formatResumeBlock(loadPrecompactState());
  const orchCtx = [
    '## [Maestro 오케스트레이션 컨텍스트]',
    `- 파이프라인: ${pipeline.join(' → ')}`,
    `- 범위: ${scope} | 추정 작업 수: ${task_count}`,
    `- ${timeBudget}`,
    security.length ? `- 보안 민감: ${security.join(', ')} → Reviewer 검토 필수` : '',
    stacks.length   ? `- 스택: ${stacks.join(', ')} → Context7 최신 API 확인 필수` : '',
    '',
    '각 에이전트 호출 시 계획서 전문을 컨텍스트로 전달한다.',
  ].filter(Boolean).join('\n');

  const parts = [orchCtx];
  if (context7Block) parts.push(context7Block);
  if (intent === 'scout_loop') parts.push(SCOUT_RALPH_PROTOCOL_BLOCK);
  if (resumeBlock) parts.push(resumeBlock);
  if (savedTodos) parts.push(savedTodos);
  if (todoBlock) parts.push(todoBlock);
  parts.push(buildOriginalRequestBlock(prompt));

  return {
    continue: true,
    hookSpecificOutput: statusLine,
    modifiedParameters: { userMessage: buildUserMessage(analysis, parts, source) },
  };
}

module.exports = {
  buildOutput,
  buildDisclosureHeader,
  ensureContext7InPipeline,
  buildContext7EnforcementBlock,
};
