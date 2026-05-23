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
 *
 * .env (프로젝트 루트):
 *   OPENCODE_API_KEY    OpenCode Go API 키
 *   OPENCODE_API_BASE   https://opencode.ai/zen/go/v1
 *   OPENCODE_HOOK_MODEL deepseek-v4-flash
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── .env 파싱 (dotenv 패키지 없이) ─────────────────────────────────
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*([\w_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}
loadEnv();

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

const raw       = process.env.USER_PROMPT || '';
const prompt    = raw.trim();
const agentName = (process.env.AGENT_NAME || '').trim();
const API_KEY   = process.env.OPENCODE_API_KEY  || '';
const API_BASE  = process.env.OPENCODE_API_BASE  || 'https://opencode.ai/zen/go/v1';
// ── 프롬프트 인젝션 방지 sanitize ────────────────────────────
function sanitizeForPrompt(value, maxLen = 200) {
  if (!value || typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t]+/g, ' ')   // 줄바꿼/탭 → 공백 (role spoofing 방지)
    .replace(/[`\[\]]/g, '')       // backticks/brackets 제거
    .trim()
    .slice(0, maxLen);
}
// ── 저장된 todo 상태 읽기 (컨텍스트 압축 생존 보장) ─────────────
function loadSavedTodos() {
  const stateFile = path.resolve(process.cwd(), '.github', 'logs', 'current-todos.json');
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
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
const MODEL     = process.env.OPENCODE_HOOK_MODEL || 'deepseek-v4-flash';

// ── LLM 실패 이유 추적 (module-level) ────────────────────────────
let _llmErrorReason = null;

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
    for (const g of state.gitStatus) lines.push(`  ${sanitizeForPrompt(g, 120)}`);
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

// ── Maestro: LLM 분류 스킵, todo만 주입 ──────────────────────────
if (agentName === 'Maestro') {
  const savedTodos  = loadSavedTodos();
  const resumeBlock = formatResumeBlock(loadPrecompactState());
  const parts = [];
  if (resumeBlock) parts.push(resumeBlock);
  parts.push(
    '## [Maestro todo 가이드]',
    '오케스트레이션 시작 전 반드시 todo로 파이프라인을 계획한다:',
    '1. `todo` 도구로 에이전트 파이프라인 목록을 생성한다.',
    '2. 각 에이전트 호출을 `in-progress`로 변경 후 위임한다.',
    '3. 에이전트 완료 즉시 `completed`로 표시한다.',
    '4. Reviewer 승인 후 전체 todo를 최종 확인한다.',
    '',
    '> 계획 없이 에이전트를 호출하는 것은 허용되지 않는다.',
  );
  if (savedTodos) parts.push('', savedTodos);
  parts.push('', '## [원본 요청]', prompt);
  const promptSummary = audit ? audit.summarize(prompt, 100) : prompt.slice(0, 100);
  tryAudit({ event: 'maestro_passthrough', source: 'UserPromptSubmit', agentName, promptSummary });
  out({ continue: true, modifiedParameters: { userMessage: parts.join('\n') } });
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════
// LLM 분류 시스템 프롬프트
// ══════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `CRITICAL INSTRUCTION: You must respond with ONLY a raw JSON object. No explanations, no code, no markdown, no text before or after the JSON.

You classify coding tasks for a multi-agent system called Maestro.

Required JSON schema (fill in values based on the user request):
{"intent":"implement","complexity":5,"scope":"single","security":[],"stacks":[],"task_count":1,"pipeline":["Planner","Implementer","Reviewer"],"needs_todo":true,"reason":"Korean 1-sentence reason"}

Field rules:
- intent: "implement"(new code) | "fix"(bug) | "investigate"(root cause analysis, debugging) | "review"(audit) | "document"(docs) | "plan"(design only) | "question"(explain) | "query"(simple lookup)
- complexity: 0-10 integer (simple=1-2, moderate=4-5, complex=7-8, architecture=9-10)
- scope: "single"(one file) | "multi"(several files) | "architecture"(whole project)
- security: subset of ["auth","password","api-key","session","db-query","env-vars","crypto","vuln-pattern"]
- stacks: detected frameworks e.g. ["Next.js","Prisma","Supabase"]
- task_count: number of distinct subtasks (1-10)
- pipeline: ordered agent list from ["Context7 Docs Agent","Planner","Implementer","Reviewer","Documenter","Investigator"]
- For intent=fix: pipeline MUST start with Investigator: ["Investigator","Implementer","Reviewer"]
- For intent=investigate: pipeline is ["Investigator"] only
- needs_todo: true if complexity >= 3
- reason: one Korean sentence explaining the classification

OUTPUT: Start your response with { and end with }. Nothing else.`;

// ══════════════════════════════════════════════════════════════════
// LLM 호출 (timeout: 4초)
// ══════════════════════════════════════════════════════════════════
async function classifyWithLLM(userPrompt) {
  _llmErrorReason = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 400,
        thinking: { type: 'disabled' },
      }),
    });

    if (!res.ok) {
      _llmErrorReason = `http_error:${res.status}`;
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    // JSON만 추출 (마크다운 펜스 제거)
    // JSON 블록 추출: 마크다운 펜스 제거 후 { ... } 추출
    const stripped = text.replace(/```json?\n?/g, '').replace(/```/g, '');
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) {
      _llmErrorReason = 'json_no_match';
      throw new Error('No JSON found in response');
    }
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.complexity === 'number') {
      parsed.complexity = Math.min(Math.max(parsed.complexity, 0), 10);
    }
    return parsed;
  } catch (e) {
    if (!_llmErrorReason) {
      if (controller.signal.aborted) {
        _llmErrorReason = 'timeout_abort';
      } else if (e instanceof SyntaxError) {
        _llmErrorReason = 'json_parse_error';
      } else {
        _llmErrorReason = `error:${String(e.message || '').slice(0, 40)}`;
      }
    }
    return null; // 폴백 트리거
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════════════════════
// Regex 폴백 분류기 (LLM 실패 시)
// ══════════════════════════════════════════════════════════════════
function classifyWithRegex(p) {
  let intent = 'query';
  // review/audit는 question보다 먼저 평가 — review+question 혼합 프롬프트는 review로 처리
  if (/리뷰|검토|확인해|review|audit/i.test(p))                               intent = 'review';
  else if (/\?$|뭐야|알려줘|설명해줘|what\s+is|how\s+does|explain/i.test(p)) intent = 'question';
  else if (/문서화|docs|document/i.test(p))                                    intent = 'document';
  else if (/왜|원인|루트|디버그|조사|investigate/i.test(p))                    intent = 'investigate';
  else if (/고쳐|버그|에러|fix|debug/i.test(p))                                intent = 'fix';
  else if (/설계|계획|plan|design|architect/i.test(p))                         intent = 'plan';
  else if (/만들어|추가해|구현해|build|create|implement/i.test(p))              intent = 'implement';

  let complexity = 0;
  const SIGNALS = [
    [/만들어|추가해|구현해|build|create|implement/i, 3],
    [/설계|아키텍처|refactor/i, 2],
    [/여러.*파일|multiple.*files|codebase/i, 2],
    [/auth|jwt|password|api.?key/i, 2],
    [/마이그레이션|migration/i, 2],
    [/테스트.*작성|write.*test/i, 1],
  ];
  for (const [re, pts] of SIGNALS) if (re.test(p)) complexity += pts;
  complexity = Math.min(complexity, 10);

  const scope = /전체|모든.*파일|codebase/i.test(p) ? 'architecture'
              : /여러.*파일|multiple.*files/i.test(p) ? 'multi' : 'single';

  const security = [];
  if (/auth|인증/i.test(p))      security.push('auth');
  if (/jwt|session/i.test(p))    security.push('session');
  if (/password|비밀번호/i.test(p)) security.push('password');
  if (/api.?key|token/i.test(p)) security.push('api-key');

  const stacks = [];
  const LIBS = [['next\\.?js','Next.js'],['react','React'],['prisma','Prisma'],
    ['supabase','Supabase'],['express','Express'],['tailwind','Tailwind'],
    ['vue','Vue'],['docker','Docker']];
  for (const [re, name] of LIBS) if (new RegExp(re,'i').test(p)) stacks.push(name);

  const PIPELINE_MAP = {
    question: ['Context7 Docs Agent'], query: ['Context7 Docs Agent'],
    document: ['Context7 Docs Agent','Documenter'], review: ['Reviewer'],
    plan: ['Planner'],
    fix: ['Investigator','Implementer','Reviewer'],
    investigate: ['Investigator'],
    implement: ['Planner','Implementer','Reviewer'],
  };

  return {
    intent, complexity, scope, security, stacks,
    task_count: 1,
    pipeline: PIPELINE_MAP[intent],
    needs_todo: !['question','query'].includes(intent),
    reason: `[regex폴백] ${intent} 작업 감지`,
  };
}

// ══════════════════════════════════════════════════════════════════
// 출력 빌더
// ══════════════════════════════════════════════════════════════════
function buildOutput(analysis, usedLLM) {
  const { intent, complexity, scope, security, stacks,
          task_count, pipeline, needs_todo, reason } = analysis;

  const source = usedLLM ? `🤖 LLM(${MODEL})` : '⚙️ regex폴백';

  // 단순 요청 — 라우팅 정보만 표시하고 패스스루
  if (complexity < 3) {
    return {
      continue: true,
      hookSpecificOutput: `💬 [Maestro] \`${intent}\` (${source} | 복잡도: ${complexity}/10) — ${reason}`,
    };
  }

  // ── HITL gate: 복잡도 8+ 또는 보안 민감 → 사용자 확인 요청 ──
  const isHighRisk = complexity >= 8 || (security.length > 0 && complexity >= 6);
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
        `⚠️ **고위험 작업 감지** (복잡도: ${complexity}/10)`,
        `- 파이프라인: ${pipeline.join(' → ')}`,
        `- 범위: ${scope}${secNote}`,
        `- 판단: ${reason}`,
        '',
        '이 작업을 진행하시겠습니까? 계속하려면 "진행해줘"라고 입력하세요.',
      ].join('\n'),
    };
  }

  // ── 시간예산 추정 ──────────────────────────────────────────────
  const timePerAgent = { Planner: 1, Investigator: 2, Implementer: 2, Reviewer: 1, Documenter: 2, 'Context7 Docs Agent': 1 };
  const estMinutes = pipeline.reduce((sum, a) => sum + (timePerAgent[a] || 1), 0) * task_count;
  const timeBudget = `⏱ 예상 소요: ~${estMinutes}분 (에이전트 ${pipeline.length}개 × 작업 ~${task_count}개)`;

  const todoBlock = needs_todo ? [
    '## [필수] 작업 시작 전 todo 계획 수립',
    '반드시 다음 순서를 지킨다:',
    '1. `todo` 도구로 할 일 목록을 **먼저** 생성한다.',
    '2. 각 항목을 `in-progress`로 변경한 뒤 작업을 시작한다.',
    '3. 완료 즉시 `completed`로 표시한다.',
    '4. 모든 작업 완료 후 todo 목록을 최종 확인한다.',
    '',
    '> todo 없이 `edit` / `execute` 도구를 사용하는 것은 허용되지 않는다.',
  ].join('\n') : null;

  const statusLine = [
    `**${complexity >= 6 ? '⚙️ Maestro 파이프라인 활성화' : '💡 Maestro 제안'}**`,
    `(${source} | 복잡도: ${complexity}/10)`,
    `\n- 의도: \`${intent}\` | 범위: \`${scope}\` | 작업 수: ~${task_count}`,
    `\n- 파이프라인: ${pipeline.join(' → ')}`,
    `\n- ${timeBudget}`,
    security.length ? `\n- 보안: ${security.join(', ')}` : '',
    stacks.length   ? `\n- 스택: ${stacks.join(', ')}` : '',
    `\n- 판단 이유: ${reason}`,
  ].filter(Boolean).join('');

  // 중간 복잡도 (3~5): todo 주입 + 제안
  if (complexity < 6) {
    const savedTodos  = loadSavedTodos();
    const resumeBlock = formatResumeBlock(loadPrecompactState());
    const parts = [];
    if (resumeBlock) parts.push(resumeBlock);
    if (savedTodos) parts.push(savedTodos);
    if (todoBlock) parts.push(todoBlock);
    parts.push('## [원본 요청]', prompt);
    return {
      continue: true,
      hookSpecificOutput: statusLine,
      modifiedParameters: { userMessage: parts.join('\n\n') },
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
  if (resumeBlock) parts.push(resumeBlock);
  if (savedTodos) parts.push(savedTodos);
  if (todoBlock) parts.push(todoBlock);
  parts.push('## [원본 요청]', prompt);

  return {
    continue: true,
    hookSpecificOutput: statusLine,
    modifiedParameters: { userMessage: parts.join('\n\n') },
  };
}

// ══════════════════════════════════════════════════════════════════
// 메인
// ══════════════════════════════════════════════════════════════════
(async () => {
  if (!prompt) { out({ continue: true }); return; }

  let analysis = null;
  let usedLLM  = false;

  const promptSummary = audit ? audit.summarize(prompt, 100) : prompt.slice(0, 100);

  if (API_KEY) {
    const t0 = Date.now();
    analysis = await classifyWithLLM(prompt);
    const durationMs = Date.now() - t0;
    if (analysis) {
      usedLLM = true;
      tryAudit({ event: 'llm_classify', source: 'UserPromptSubmit', status: 'success', durationMs, intent: analysis.intent, pipeline: analysis.pipeline, complexity: analysis.complexity, model: MODEL, agentName, promptSummary });
    } else {
      tryAudit({ event: 'llm_classify', source: 'UserPromptSubmit', status: 'failed', durationMs, errorReason: _llmErrorReason, model: MODEL, agentName, promptSummary });
    }
  } else {
    tryAudit({ event: 'llm_classify', source: 'UserPromptSubmit', status: 'skipped', reason: 'no_api_key', agentName, promptSummary });
  }

  if (!analysis) {
    analysis = classifyWithRegex(prompt);
    tryAudit({ event: 'regex_fallback', source: 'UserPromptSubmit', intent: analysis.intent, pipeline: analysis.pipeline, complexity: analysis.complexity, fallbackReason: _llmErrorReason || 'no_api_key', reason: analysis.reason, agentName, promptSummary });
  }

  const result = buildOutput(analysis, usedLLM);
  tryAudit({ event: 'final_pipeline', source: 'UserPromptSubmit', pipeline: analysis.pipeline, intent: analysis.intent, complexity: analysis.complexity, usedLLM, agentName, promptSummary, hitl: result.decision === 'ask' });

  out(result);
})();

function out(obj) { process.stdout.write(JSON.stringify(obj)); }
