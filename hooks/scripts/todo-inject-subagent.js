#!/usr/bin/env node
/**
 * Subagent Start — Todo Injection Hook
 *
 * SubagentStart 이벤트에서 실행.
 * 모든 서브에이전트에게 todo 사용 의무를 주입한다.
 * 에이전트 유형에 따라 맞춤형 todo 가이드를 제공한다.
 *
 * 환경변수:
 *   SUBAGENT_NAME   호출된 서브에이전트 이름
 *   USER_PROMPT     원본 사용자 요청 (상위 에이전트가 전달)
 *
 * async 동작:
 *   1. 에이전트의 .agent.md 파일을 비동기로 읽어 description 추출
 *   2. 파일 없으면 hardcoded 가이드로 폴백
 *   3. 두 작업(파일 읽기 + 가이드 선택)을 Promise.all로 병렬 처리
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { wrapUntrusted } = require('./router/env-utils');

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function trySubagentFlow(obj) { if (!audit) return; try { audit.appendSubagentFlow(obj); } catch (_) {} }
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

const agentName = (process.env.SUBAGENT_NAME || process.env.AGENT_NAME || '').trim();
const prompt    = (process.env.USER_PROMPT || '').trim();

// ── .agent.md 에서 description 비동기 추출 ─────────────────────────
async function readAgentDescription(name) {
  if (!name) return null;
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const candidates = [
    path.resolve(process.cwd(), `.github/agents/${slug}.agent.md`),
    path.resolve(process.cwd(), `.github/agents/${name}.agent.md`),
  ];
  for (const filePath of candidates) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      // YAML frontmatter에서 description 추출
      const m = content.match(/^description:\s*[>|]?\s*\n?([\s\S]*?)(?=\n\w|\n---)/m);
      if (m) return m[1].replace(/^\s+/gm, '').replace(/\n+/g, ' ').trim().slice(0, 120);
    } catch {
      // 파일 없으면 다음 후보 시도
    }
  }
  return null;
}

// ── 에이전트별 todo 전략 ────────────────────────────────────────────
const AGENT_TODO_GUIDE = {
  'Planner': [
    '## [Planner todo 가이드]',
    '계획 수립 시 반드시 todo로 분석 단계를 추적한다:',
    '1. [ ] 코드베이스 탐색 (관련 파일, 패턴 파악)',
    '2. [ ] Context7로 필요한 라이브러리 API 확인',
    '3. [ ] 영향 범위 파악 (변경이 미치는 모듈)',
    '4. [ ] 구현 계획서 작성 (변경 파일 + 단계별 작업)',
    '',
    '> 계획서 없이 Implementer에게 넘기지 않는다.',
  ].join('\n'),

  'Implementer': [
    '## [Implementer todo 가이드]',
    '구현 시 반드시 todo로 파일별 진행을 추적한다:',
    '1. [ ] 계획서 검토 및 작업 목록 todo 생성',
    '2. [ ] Context7로 사용할 라이브러리 최신 API 확인',
    '3. [ ] 파일별 구현 (각 파일을 개별 todo 항목으로)',
    '4. [ ] 구현 후 **Tester 에이전트 호출** (테스트 실행 위임)',
    '5. [ ] test-evidence.json result=PASS 확인 후 Reviewer 호출',
    '',
    '> todo 없이 edit 도구를 사용하는 것은 허용되지 않는다.',
    '> ⛔ test-evidence.json PASS 없이 "구현완료" 표현 금지 — "테스트 대기"로 표현할 것.',
  ].join('\n'),

  'Reviewer': [
    '## [Reviewer todo 가이드]',
    '리뷰 시 반드시 todo로 체크리스트를 추적한다:',
    '0. [ ] .github/logs/test-evidence.json 확인 — result=PASS + ts >= test-gate-state.requiredSince (파일 변경 이후 PASS) 필수',
    '   (test-gate-state.json 없으면 requiredSince 조건 면제. stale PASS도 거부 대상.)',
    '1. [ ] OWASP Top 10 보안 취약점 검토',
    '2. [ ] 타입 안전성 및 런타임 오류 가능성 확인',
    '3. [ ] 성능 이슈 (N+1 쿼리, 불필요한 재렌더링 등)',
    '4. [ ] 코드 품질 (중복, 과도한 복잡도, 명명 규칙)',
    '5. [ ] 리뷰 결과 요약 (승인 / 수정 필요)',
    '',
    '> 크리티컬 이슈 발견 시 continue: false를 검토한다.',
    '> ⛔ test-evidence.json PASS 없이, 또는 stale PASS(파일 변경 이전 증거)로 "검증완료" 표현 금지.',
    '> Tester 에이전트를 먼저 실행할 것.',
  ].join('\n'),

  'Investigator': [
    '## [Investigator todo 가이드]',
    '조사 시 반드시 todo로 4단계 RCA(Root Cause Analysis)를 추적한다:',
    '1. [ ] 재현 경로 파악 (오류 메시지 → 최초 발생 지점)',
    '2. [ ] 관련 코드 읽기 (데이터 흐름 추적, read/search 전용)',
    '3. [ ] 원인 가설 2~4개 수립 → 코드 증거 확인 → 원인 확정',
    '4. [ ] 조사 보고서 작성 (수정 방향 + 범위 평가)',
    '',
    '> 코드를 수정하지 않는다. 읽기(read)와 검색(search)만 허용된다.',
    '> 원인 불명확 시 "추가 정보 필요"라고 명시하고 작업을 중단한다.',
  ].join('\n'),

  'Documenter': [
    '## [Documenter todo 가이드]',
    '문서화 시 5단계를 todo로 추적한다:',
    '1. [ ] 기능 목록 파악 (전체 옵션/API 스캔)',
    '2. [ ] 예제 설계 (실제 동작하는 코드 예제)',
    '3. [ ] 파일 구조 결정',
    '4. [ ] README / 가이드 작성',
    '5. [ ] _OPTIONS.md (모든 옵션 레퍼런스) 작성',
  ].join('\n'),

  'Tester': [
    '## [Tester todo 가이드]',
    '테스트 실행 시 반드시 todo로 단계를 추적한다:',
    '1. [ ] 프로젝트 테스트 명령 탐지 (package.json / pyproject.toml / go.mod 등)',
    '2. [ ] run_in_terminal로 테스트 실행',
    '3. [ ] 결과 분석 (exit code + stdout/stderr)',
    '4. [ ] .github/logs/test-evidence.json 기록',
    '5. [ ] PASS → Reviewer 핸드오프 / FAIL → Implementer 반환',
    '',
    '> 코드를 수정하지 않는다. 테스트 실행과 결과 기록만 담당한다.',
    '> ⛔ 테스트 결과 조작 금지. 실패는 실패로 기록한다.',
  ].join('\n'),

  'Maestro': [
    '## [Maestro todo 가이드]',
    '오케스트레이션 시작 전 반드시 todo로 파이프라인을 계획한다:',
    '1. [ ] 요청 유형 분류 (A~G) 및 파이프라인 결정',
    '2. [ ] 각 에이전트 호출을 todo 항목으로 등록',
    '3. [ ] 에이전트 순서대로 위임 (완료 즉시 completed 표시)',
    '4. [ ] Reviewer 승인 확인 후 파이프라인 종료',
    '',
    '> 계획 없이 에이전트를 호출하는 것은 허용되지 않는다.',
  ].join('\n'),

  'Context7 Docs Agent': [
    '## [Context7 Docs Agent todo 가이드]',
    '라이브러리 조회 시 todo로 추적한다:',
    '1. [ ] resolve-library-id로 라이브러리 ID 확인',
    '2. [ ] query-docs로 필요한 기능 문서 조회',
    '3. [ ] 조회 결과 기반 코드 스니펫 생성',
  ].join('\n'),
};

// ── 기본 가이드 (에이전트 이름 미매핑 시) ──────────────────────────
const DEFAULT_GUIDE = [
  '## [todo 사용 가이드]',
  '작업 시작 전 반드시 todo 도구로 계획을 수립한다:',
  '1. `todo` 도구로 할 일 목록을 생성한다.',
  '2. 각 항목을 `in-progress`로 변경 후 작업한다.',
  '3. 완료 즉시 `completed`로 표시한다.',
].join('\n');

// ── 메인 (async) ───────────────────────────────────────────────────
(async () => {
  // 1. .agent.md 읽기 + 가이드 선택 — 두 작업 병렬 처리
  const [description, guide] = await Promise.all([
    readAgentDescription(agentName),                        // 비동기: 파일 I/O
    Promise.resolve(AGENT_TODO_GUIDE[agentName] || DEFAULT_GUIDE), // 동기값을 Promise로 래핑
  ]);

  // 2. 에이전트 설명이 있으면 헤더에 포함
  const agentLabel = description
    ? `${agentName} — ${description}`
    : (agentName || '에이전트');

  // 3. 원본 요청 컨텍스트 블록 (민감정보 redaction 적용)
  const safePrompt = audit ? audit.summarize(prompt, 500) : (prompt || '').slice(0, 500);
  const promptSuffix = (prompt || '').length > 500 ? '\n...(생략)' : '';
  const contextBlock = safePrompt
    ? `\n\n## [상위 컨텍스트]\n${wrapUntrusted('parent-context', `${safePrompt}${promptSuffix}`)}`
    : '';

  // 4. Subagent flow / audit 기록
  const sessionId = (process.env.SESSION_ID || '').trim();
  const guideType = Object.prototype.hasOwnProperty.call(AGENT_TODO_GUIDE, agentName) ? agentName : 'default';
  let correlationId;
  try {
    correlationId = require('crypto').randomUUID();
  } catch (_) {
    correlationId = `${agentName || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
  const seq           = audit ? audit.nextSeq() : 0;
  const promptSummary = audit ? audit.summarize(prompt, 100) : (prompt || '').slice(0, 100);

  trySubagentFlow({
    event:         'SubagentStart',
    agentName:     agentName || null,
    sessionId:     sessionId || null,
    seq,
    correlationId,
    guideType,
    promptSummary,
  });

  // 5. last-subagent-start.json 저장 (agentName별 start stack, max 20)
  try {
    const logsDir       = path.resolve(process.cwd(), '.github', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const lastStartFile = path.join(logsDir, 'last-subagent-start.json');
    let starts = {};
    try { starts = JSON.parse(fs.readFileSync(lastStartFile, 'utf8')); } catch (_) {}
    const startRecord = { startTs: new Date().toISOString(), seq, correlationId, sessionId: sessionId || null, agentName: agentName || null };
    if (agentName) {
      if (!Array.isArray(starts[agentName])) starts[agentName] = [];
      starts[agentName].push(startRecord);
      if (starts[agentName].length > 20) starts[agentName] = starts[agentName].slice(-20);
    }
    starts['__last__'] = startRecord;
    fs.writeFileSync(lastStartFile, JSON.stringify(starts, null, 2), 'utf8');
  } catch (_) {}

  tryAudit({
    event:         'subagent_start',
    source:        'SubagentStart',
    agentName:     agentName || null,
    sessionId:     sessionId || null,
    seq,
    correlationId,
    guideType,
    promptSummary,
  });

  // 6. 결과 출력 (훅 응답)
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: `📋 **${agentLabel}** 시작 — todo 계획 수립 필수`,
    modifiedParameters: {
      userMessage: `${guide}${contextBlock}`,
    },
  }));
})();
