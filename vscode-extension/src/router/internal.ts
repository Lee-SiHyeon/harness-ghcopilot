import { HarnessPaths } from '../state/paths';
import { loadActionItems } from '../state/action-items';
import { loadPrecompactBlock, loadSavedTodosBlock } from '../state/resume';
import { loadPipelineConfig, normalizePipeline, requiresAuditAndRelease } from '../pipeline/config';

export interface InternalAnalysis {
  intent: string;
  complexity: number;
  scope: 'single' | 'multi' | 'architecture';
  security: string[];
  stacks: string[];
  task_count: number;
  pipeline: string[];
  needs_todo: boolean;
  reason: string;
  classifier: string;
}

const INTENT_PIPELINES: Record<string, string[]> = {
  question: [],
  query: [],
  inspect: ['Inspector'],
  document: ['Context7 Docs Agent', 'Documenter'],
  review: ['Reviewer'],
  plan: ['Planner'],
  fix: ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'],
  investigate: ['Investigator'],
  implement: ['Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'],
  release: ['Release', 'Critic'],
  scout: ['Scout'],
  scout_loop: ['Scout', 'Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'],
};

const LIBS: Array<[RegExp, string]> = [
  [/next\.?js/i, 'Next.js'],
  [/react/i, 'React'],
  [/prisma/i, 'Prisma'],
  [/supabase/i, 'Supabase'],
  [/express/i, 'Express'],
  [/tailwind/i, 'Tailwind'],
  [/vue/i, 'Vue'],
  [/docker/i, 'Docker'],
  [/langgraph/i, 'LangGraph'],
  [/vscode|vs code/i, 'VS Code'],
];

function shouldUseContext7(prompt: string, intent: string, stacks: string[]): boolean {
  if (stacks.length === 0) return false;
  if (/context7|공식\s*문서|최신\s*api|latest\s+api|based\s+on\s+official\s+docs/i.test(prompt)) return true;
  return ['implement', 'fix', 'document', 'plan', 'release', 'scout_loop'].includes(intent);
}

const INTENT_RULES: ReadonlyArray<{ re: RegExp; intent: string; reason: string }> = [
  { re: /scout.*ralph|ralph.*scout|scout\s*loop|자기개선.*루프|완료까지.*scout|scout.*완료까지/i, intent: 'scout_loop', reason: 'scout_loop keywords' },
  { re: /자기개선|트렌드|최신.*패턴|awesome.*harness.*engineering|github.*stars?|scout/i, intent: 'scout', reason: 'scout keywords' },
  { re: /안\s*연결|누락\s*됐|not.*wired|missing.*pipeline|missing.*agent/i, intent: 'fix', reason: 'missing/not-wired pattern' },
  { re: /push\s*protection|secret\s*scanning|푸시.*거부|push.*rejected/i, intent: 'fix', reason: 'push protection fix pattern' },
  { re: /(?:release|gate|context|history|배지).*왜|why.*(?:context|history|missing|release|gate)/i, intent: 'investigate', reason: 'why release/context pattern' },
  { re: /커밋|푸시|push|commit|릴리즈|배포해|버전.*올려|publish|deploy(?!ment)|release|tag/i, intent: 'release', reason: 'release/commit/push keywords' },
  { re: /문서화|docs|document|README|레퍼런스|설명\s*문서|문서\s*작성/i, intent: 'document', reason: 'document keywords' },
  { re: /리뷰|검토|확인해|점검해|inspect|review|audit/i, intent: 'review', reason: 'review keywords' },
  { re: /보안|취약점|수정하지\s*말고|파일\s*수정하지\s*말고/i, intent: 'review', reason: 'read-only review/security keywords' },
  { re: /고쳐|수정해|해결|버그|에러|fix|debug|push protection|OOM|CI\s*고쳐/i, intent: 'fix', reason: 'fix/bug/debug keywords' },
  { re: /부족|아쉬운|개선점|문제점|보완할|빠져\s*있|약점|병목|평가|분석만|read-only\s*분석|what.*(?:missing|lacking)|(?:missing|lacking).*(?:what|feature)/i, intent: 'inspect', reason: 'lacking/inspection pattern' },
  { re: /왜.*(?:안\s*돼|안\s*되|안\s*됨|에러|오류|버그|실패|crash|안\s*따르|안\s*지키|안\s*따라|막힘|missing)|(?:에러|오류|버그|실패|crash).*왜|root\s*cause|원인|안\s*보여\s*왜|이상하게\s*대답/i, intent: 'investigate', reason: 'why-error pattern' },
  { re: /디버그|디버깅/i, intent: 'investigate', reason: '디버그/디버깅 keywords' },
  { re: /어떻게\s*구현|아키텍처\s*잡|설계|계획|plan|design|architect/i, intent: 'plan', reason: 'plan keywords' },
  { re: /만들어|추가|구현|작성|생성|리팩토링|최적화|정리|구조\s*바꿔|보강|개선|build|create|implement|improve|마이그레이션|migration/i, intent: 'implement', reason: 'implement keywords' },
  { re: /\?$|뭐야|알려줘|설명해줘|what\s+is|how\s+does|explain/i, intent: 'question', reason: 'question pattern' },
  { re: /요약|summary/i, intent: 'question', reason: 'summary/question keywords' },
  { re: /왜|루트|디버그|조사|investigate/i, intent: 'investigate', reason: '왜/조사/investigate keywords' },
];

export function classifyPrompt(prompt: string, paths: HarnessPaths): InternalAnalysis {
  const p = prompt || '';
  let intent = 'query';
  let intentReason = 'default fallback';
  for (const rule of INTENT_RULES) {
    if (rule.re.test(p)) {
      intent = rule.intent;
      intentReason = rule.reason;
      break;
    }
  }
  let complexity = 0;
  const signals: Array<[RegExp, number]> = [
    [/만들어|추가해|구현해|작성해|작성해줘|build|create|implement/i, 3],
    [/설계|아키텍처|refactor|마이그레이션|migration/i, 2],
    [/여러.*파일|multiple.*files|codebase|전체|풀|full/i, 2],
    [/auth|jwt|password|api.?key|token/i, 2],
    [/테스트.*작성|write.*test|검증/i, 1],
  ];
  for (const [re, pts] of signals) if (re.test(p)) complexity += pts;
  if (intent === 'scout_loop') complexity = Math.max(complexity, 6);
  complexity = Math.min(complexity, 10);

  const scope = /전체|모든.*파일|codebase|full|풀/i.test(p)
    ? 'architecture'
    : /여러.*파일|multiple.*files/i.test(p)
      ? 'multi'
      : 'single';
  const security: string[] = [];
  if (/auth|인증/i.test(p)) security.push('auth');
  if (/jwt|session/i.test(p)) security.push('session');
  if (/password|비밀번호/i.test(p)) security.push('password');
  if (/api.?key|token|pat/i.test(p)) security.push('api-key');

  const stacks: string[] = [];
  for (const [re, name] of LIBS) if (re.test(p)) stacks.push(name);

  const config = loadPipelineConfig(paths);
  const ssotMatch = config.pipelines.find(pipe => (pipe.keywords || []).some(k => p.includes(k)));
  const useSsotMatch = intent === 'query';
  const base = (useSsotMatch ? ssotMatch?.steps : undefined) || INTENT_PIPELINES[intent] || INTENT_PIPELINES.query;
  let pipeline = normalizePipeline(intent, base);
  if (shouldUseContext7(p, intent, stacks) && !pipeline.includes('Context7 Docs Agent')) {
    pipeline = ['Context7 Docs Agent', ...pipeline];
  }

  return {
    intent,
    complexity,
    scope,
    security,
    stacks,
    task_count: 1,
    pipeline,
    needs_todo: requiresAuditAndRelease(intent) || complexity >= 3,
    reason: `[extension-router] ${intentReason} → ${intent}`,
    classifier: 'Extension TS router',
  };
}

export function buildInternalUserMessage(analysis: InternalAnalysis, prompt: string, paths: HarnessPaths): string {
  const parts: string[] = [];
  const resumeBlock = loadPrecompactBlock(paths);
  if (resumeBlock) parts.push(resumeBlock);
  const todosBlock = loadSavedTodosBlock(paths);
  if (todosBlock) parts.push(todosBlock);
  const actionItems = loadActionItems(paths);
  if (actionItems.length > 0) {
    parts.push('## [자가비평 actionItems]');
    parts.push(`미해결 개선 항목 ${actionItems.length}건이 있다. 이번 실행에서 먼저 해소하고 완료 후 actionItems를 초기화한다.`);
    for (const item of actionItems.slice(0, 10)) {
      parts.push(`- ${item.agent || '?'} / ${item.source || '?'}: ${item.message || '(message 없음)'}`);
    }
  }
  if (analysis.stacks.length > 0) {
    parts.push('## [라이브러리 감지 — Context7 호출 필수]');
    parts.push(`감지된 스택: ${analysis.stacks.join(', ')}. 최신 공식 문서 확인 전 추측 답변 금지.`);
  }
  if (analysis.pipeline.length > 0) {
    parts.push('## [파이프라인 강제]');
    parts.push(`정해진 파이프라인: ${analysis.pipeline.join(' → ')}. 이 순서를 변경하지 않는다.`);
  } else {
    parts.push('## [직접 답변 모드]');
    parts.push('후속 에이전트, 감사 단계, 마무리 커밋을 실행하지 말고 사용자 질문에 바로 답한다.');
  }
  parts.push('## [원본 요청]');
  parts.push(prompt);
  return parts.join('\n\n');
}

export function buildBadge(analysis: InternalAnalysis): string {
  const pipeline = analysis.pipeline.length > 0 ? analysis.pipeline.join(' → ') : '직접 답변';
  return [
    `🎯 **작업 유형**: ${analysis.intent}`,
    `📋 **파이프라인**: ${pipeline}`,
    `🔍 **분류 방식**: ${analysis.classifier}`,
  ].join('\n');
}
