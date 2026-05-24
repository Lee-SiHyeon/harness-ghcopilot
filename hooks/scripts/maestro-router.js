#!/usr/bin/env node
/**
 * Maestro Router — LLM-Powered Routing (OpenCode Go)
 *
 * UserPromptSubmit 단계에서 실행.
 * OpenCode Go API(deepseek-v4-flash)로 프롬프트를 분석하여:
 *   1. 작업 유형·복잡도·보안민감도·스택·범위를 LLM이 직접 판단
 *   2. 최적 에이전트 파이프라인 결정
 *   3. todo 강제 주입 + Maestro 오케스트레이션 컨텍스트 주입
 *   4. API 실패 시 regex 폴백으로 동작 보장
 *
 * 환경변수 (훅 실행 시):
 *   USER_PROMPT         사용자 입력 프롬프트
 *   AGENT_NAME          현재 에이전트 이름
 *   SUBAGENT_NAME       실제 서브에이전트 내부 프롬프트일 때 설정
 *
 * .env (프로젝트 루트):
 *   OPENCODE_API_KEY    OpenCode Go API 키
 *   OPENCODE_API_BASE   https://opencode.ai/zen/go/v1
 *   OPENCODE_HOOK_MODEL deepseek-v4-flash
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { loadEnv, sanitizeForPrompt, wrapUntrusted }              = require('./router/env-utils');
const { loadSavedTodos, loadPrecompactState, formatResumeBlock } = require('./router/state-loaders');
const { loadRetrospectiveLearnings, loadActionItems, loadActionItemsCount } = require('./router/retro-loaders');
const { classifyWithGitHubModels, classifyWithRegex,
        isScoutLoopPrompt, SCOUT_RALPH_PROTOCOL_BLOCK, getLlmErrorReason } = require('./router/classifier');
const { buildOutput }                                            = require('./router/output-builder');

loadEnv();

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

const raw       = process.env.USER_PROMPT || '';
const prompt    = raw.trim();
const agentName = (process.env.AGENT_NAME || '').trim();
const subagentName = (process.env.SUBAGENT_NAME || '').trim();

if (!prompt) { out({ continue: true }); process.exit(0); }

if (subagentName) {
  const promptSummary = audit ? audit.summarize(prompt, 100) : prompt.slice(0, 100);
  tryAudit({ event: 'maestro_subagent_passthrough', source: 'UserPromptSubmit', agentName, subagentName, promptSummary });
  out({ continue: true });
  process.exit(0);
}

// ── Maestro: LLM 분류 스킵, todo만 주입 ──────────────────────────
// agentName === '' : modeInstructions 기반 세션 (VS Code Copilot 모드)
// agentName === 'Maestro' : @Maestro 에이전트 직접 선택
// KNOWN_SUBAGENTS는 추가 Maestro 컨텍스트 주입 여부만 가른다.
// 서브에이전트 이름으로 선택된 top-level 세션은 SUBAGENT_NAME이 없으므로 아래 async 경로에서 헤더 지시를 받는다.
const KNOWN_SUBAGENTS = new Set(['Planner','Implementer','Tester','Reviewer','Documenter','Investigator','Release','Critic','Scout','Context7 Docs Agent']);
const isMaestroContext = !KNOWN_SUBAGENTS.has(agentName);
if (isMaestroContext) {
  // ── 인터럽트 감지: in-progress 항목 확인 ─────────────────────
  function getInProgressTodos() {
    const stateFile = path.resolve(process.cwd(), '.github', 'logs', 'current-todos.json');
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return (raw.todos || []).filter(t => t.status === 'in-progress');
    } catch (_) { return []; }
  }

  const savedTodos  = loadSavedTodos();
  const resumeBlock = formatResumeBlock(loadPrecompactState());
  const parts = [];
  const inProgressTodos = getInProgressTodos();
  if (inProgressTodos.length > 0) {
    const lines = ['## [⚠️ 인터럽트 감지 — 진행 중 작업 있음]'];
    for (const t of inProgressTodos) lines.push(`🔄 ${sanitizeForPrompt(t.title, 100)}`);
    lines.push('', '> 새 요청 처리 전 현재 파이프라인 중단 여부를 사용자에게 확인하거나, 현재 작업 완료 후 처리한다. 컨텍스트를 혼용하지 않는다.');
    parts.push(lines.join('\n'));
  }

  const actionCount = loadActionItemsCount();
  const analysis = classifyWithRegex(prompt);  // sync path: regex만 사용 (속도 우선)
  const isScoutLoop = analysis.intent === 'scout_loop' || isScoutLoopPrompt(prompt);
  const disclosurePipeline = actionCount >= 1
    ? [`자가비평 ${actionCount}건 처리`, ...analysis.pipeline]
    : analysis.pipeline;
  parts.push(
    '## [⚠️ 필수 — 응답 첫 줄 출력 의무]',
    '아래 블록을 **응답의 첫 줄로** 반드시 출력한다. 단순 질문·짧은 답변도 예외 없음.',
    '```',
    `🎯 **작업 유형**: ${analysis.intent}`,
    `📋 **파이프라인**: ${disclosurePipeline.join(' → ')}`,
    '```',
    '이 블록 없이 내용을 출력하거나 에이전트를 호출하면 규칙 위반이다.',
  );
  if (isScoutLoop) parts.push(SCOUT_RALPH_PROTOCOL_BLOCK);
  // 미해결 개선 항목 경고 주입
  const actionWarning = loadActionItems();
  if (actionWarning) parts.push(actionWarning);
  if (resumeBlock) parts.push(resumeBlock);
  parts.push(
    '## [Maestro todo 가이드]',
    '오케스트레이션 시작 전 반드시 todo로 파이프라인을 계획한다:',
    '1. `todo` 도구로 에이전트 파이프라인 목록을 생성한다.',
    '2. 각 에이전트 호출을 `in-progress`로 변경 후 위임한다.',
    '3. 에이전트 완료 즉시 `completed`로 표시한다.',
    '4. Reviewer 승인 후 전체 todo를 최종 확인한다.',
    '5. **complexity ≥ 3이면 마지막 todo로 `Retrospective 기록` 항목을 반드시 추가한다.** 훅이 실행 데이터를 자동 기록하므로, Maestro는 자기비평과 개선점을 retrospective-history.md 최신 항목에 기입한다.',
    '',
    '> 계획 없이 에이전트를 호출하는 것은 허용되지 않는다.',
  );
  if (savedTodos) parts.push('', savedTodos);
  // 과거 회고 패턴 주입 (todo 유무 무관하게 항상 주입)
  const retroBlock = loadRetrospectiveLearnings();
  if (retroBlock) parts.push(retroBlock);
  // cost tier 초과 모델 경고 주입
  try {
    const exceededFile = path.join(process.cwd(), '.github', 'logs', 'cost-tier-exceeded.json');
    const exceededData = JSON.parse(fs.readFileSync(exceededFile, 'utf8'));
    if (Array.isArray(exceededData.models) && exceededData.models.length > 0) {
      parts.push(
        '',
        '## [사용 불가 모델 - cost tier 초과]',
        '아래 모델은 현재 cost tier를 초과합니다. runSubagent 호출 시 model 파라미터를 생략하거나, 에이전트 파일 목록에서 이 모델들을 건너뛰고 다음 폴백 모델을 선택하세요:',
        exceededData.models.map(m => `  - ${sanitizeForPrompt(String(m), 80)}`).join('\n'),
      );
    }
  } catch (_) {}
  parts.push('', '## [원본 요청]', wrapUntrusted('user-request', prompt));

  // GITHUB_PAT 미설정 시 토큰 안내 주입 (Maestro context)
  if (!process.env.GITHUB_PAT) {
    parts.push(
      '',
      '> ⚠️ **LLM 분류기 비활성 — Regex 모드로 전환되었습니다**',
      '> GitHub Personal Access Token을 `.env`에 설정하면 gpt-4o-mini 기반 인텔리전트 분류를 사용할 수 있습니다:',
      '> ```',
      '> # .env 파일 (git 추적 안 됨)',
      '> GITHUB_PAT=ghp_...',
      '> ```',
      '> 토큰 발급: https://github.com/settings/tokens',
      '> Classic Token → ✅ **`read:models`** scope 체크 후 생성하세요.',
    );
  }

  const promptSummary = audit ? audit.summarize(prompt, 100) : prompt.slice(0, 100);
  tryAudit({ event: 'maestro_passthrough', source: 'UserPromptSubmit', agentName, intent: analysis.intent, pipeline: analysis.pipeline, complexity: analysis.complexity, promptSummary });
  out({ continue: true, modifiedParameters: { userMessage: parts.join('\n') } });
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════
// 메인
// ══════════════════════════════════════════════════════════════════
(async () => {
  let analysis = null;
  let usedLLM  = false;

  const promptSummary = audit ? audit.summarize(prompt, 100) : prompt.slice(0, 100);

  // 1좌: GitHub Models API (PAT 기반, 무료, ~2-3s)
  {
    const t0 = Date.now();
    analysis = await classifyWithGitHubModels(prompt);
    const durationMs = Date.now() - t0;
    if (analysis) {
      usedLLM = true;
      tryAudit({ event: 'gh_models_classify', source: 'UserPromptSubmit', status: 'success', durationMs, intent: analysis.intent, pipeline: analysis.pipeline, complexity: analysis.complexity, model: 'gpt-4o-mini', agentName, promptSummary });
    } else {
      tryAudit({ event: 'gh_models_classify', source: 'UserPromptSubmit', status: 'failed', durationMs, errorReason: getLlmErrorReason(), agentName, promptSummary });
    }
  }

  // 2좌: Regex fallback — PAT 없으면 사용자에게 알림 주입
  if (!analysis) {
    analysis = classifyWithRegex(prompt);
    tryAudit({ event: 'regex_fallback', source: 'UserPromptSubmit', intent: analysis.intent, pipeline: analysis.pipeline, complexity: analysis.complexity, fallbackReason: getLlmErrorReason() || 'no_pat', agentName, promptSummary });

    // PAT 미설정인 경우에만 토큰 안내 주입
    const errorReason = getLlmErrorReason();
    if (!process.env.GITHUB_PAT || errorReason === 'gh_pat_not_set') {
      analysis._regexFallbackNotice = [
        '',
        '> ⚠️ **LLM 분류기 비활성 — Regex 모드로 전환되었습니다**',
        '> GitHub Personal Access Token을 `.env`에 설정하면 gpt-4o-mini 기반 인텔리전트 분류를 사용할 수 있습니다:',
        '> ```',
        '> # .env 파일 (git 추적 안 됨)',
        '> GITHUB_PAT=ghp_...',
        '> ```',
        '> 토큰 발급: https://github.com/settings/tokens',
        '> Classic Token → ✅ **`read:models`** scope 체크 후 생성하세요.',
      ].join('\n');
    }
  }

  // nah pattern: PreToolUse 가드가 읽을 수 있도록 현재 intent 저장
  try {
    const intentFile = path.join(process.cwd(), '.github', 'logs', 'current-intent.json');
    // 사용자가 특정 모델을 요청했는지 감지 (model-guard가 읽음)
    const MODEL_KEYWORDS = /\b(gemini|gpt[-\s]?\d|claude|sonnet|opus|mistral|llama|o3|o4)\b/i;
    const userRequestedModel = MODEL_KEYWORDS.test(prompt);
    fs.writeFileSync(intentFile, JSON.stringify({ intent: analysis.intent, userRequestedModel, ts: new Date().toISOString() }));
  } catch (_) {}

  const result = buildOutput(analysis, usedLLM, { prompt, MODEL: 'gpt-4o-mini', audit, tryAudit });

  // regex 모드 알림을 modifiedParameters에 주입
  if (analysis._regexFallbackNotice && result.modifiedParameters?.userMessage) {
    result.modifiedParameters.userMessage += '\n' + analysis._regexFallbackNotice;
  }

  tryAudit({ event: 'final_pipeline', source: 'UserPromptSubmit', pipeline: analysis.pipeline, intent: analysis.intent, complexity: analysis.complexity, usedLLM, agentName, promptSummary, hitl: result.decision === 'ask' });

  out(result);
})();

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

// 테스트 호환성을 위한 re-export
module.exports = { classifyWithRegex, sanitizeForPrompt, buildOutput };
