import { HarnessPaths } from '../state/paths';
import { loadActionItems } from '../state/action-items';
import { loadPrecompactBlock, loadSavedTodosBlock } from '../state/resume';
import { loadPipelineConfig, normalizePipeline } from '../pipeline/config';

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
  question: ['Context7 Docs Agent', 'Critic', 'Release'],
  query: ['Context7 Docs Agent', 'Critic', 'Release'],
  document: ['Context7 Docs Agent', 'Documenter', 'Critic', 'Release'],
  review: ['Reviewer', 'Critic', 'Release'],
  plan: ['Planner', 'Critic', 'Release'],
  fix: ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'],
  investigate: ['Investigator', 'Critic', 'Release'],
  implement: ['Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'],
  release: ['Release', 'Critic'],
  scout: ['Scout', 'Critic', 'Release'],
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

export function classifyPrompt(prompt: string, paths: HarnessPaths): InternalAnalysis {
  const p = prompt || '';
  let intent = 'query';
  if (/scout.*ralph|ralph.*scout|scout\s*loop|자기개선.*루프|완료까지.*scout|scout.*완료까지/i.test(p)) intent = 'scout_loop';
  else if (/자기개선|트렌드|최신.*패턴|awesome.*harness.*engineering|github.*stars?|scout/i.test(p)) intent = 'scout';
  else if (/리뷰|검토|확인해|점검해|inspect|review|audit/i.test(p)) intent = 'review';
  else if (/없[는것지](\s*것)?\s*같[지다아]?|빠져\s*있|누락\s*됐|안\s*연결|not.*wired|missing.*pipeline|missing.*agent/i.test(p)) intent = 'fix';
  else if (/왜.*(?:안\s*되|안\s*됨|에러|오류|버그|실패|crash|안\s*따르|안\s*지키|안\s*따라)|(?:에러|오류|버그).*왜/i.test(p)) intent = 'investigate';
  else if (/\?$|뭐야|알려줘|설명해줘|what\s+is|how\s+does|explain/i.test(p)) intent = 'question';
  else if (/문서화|docs|document/i.test(p)) intent = 'document';
  else if (/왜|원인|루트|디버그|조사|investigate/i.test(p)) intent = 'investigate';
  else if (/고쳐|버그|에러|fix|debug/i.test(p)) intent = 'fix';
  else if (/설계|계획|plan|design|architect/i.test(p)) intent = 'plan';
  else if (/릴리즈|배포해|버전.*올려|publish|deploy(?!ment)|release/i.test(p)) intent = 'release';
  else if (/만들어|추가해|구현해|build|create|implement|마이그레이션|migration/i.test(p)) intent = 'implement';

  let complexity = 0;
  const signals: Array<[RegExp, number]> = [
    [/만들어|추가해|구현해|build|create|implement/i, 3],
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
  const base = ssotMatch?.steps || INTENT_PIPELINES[intent] || INTENT_PIPELINES.query;
  let pipeline = normalizePipeline(intent, base);
  if (stacks.length > 0 && !pipeline.includes('Context7 Docs Agent')) {
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
    needs_todo: !['question', 'query'].includes(intent) || complexity >= 3,
    reason: `[extension-router] ${intent} 작업 감지`,
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
  parts.push('## [파이프라인 강제]');
  parts.push(`정해진 파이프라인: ${analysis.pipeline.join(' → ')}. 이 순서를 변경하지 않는다.`);
  parts.push('## [원본 요청]');
  parts.push(prompt);
  return parts.join('\n\n');
}

export function buildBadge(analysis: InternalAnalysis): string {
  return [
    `🎯 **작업 유형**: ${analysis.intent}`,
    `📋 **파이프라인**: ${analysis.pipeline.join(' → ')}`,
    `🔍 **분류 방식**: ${analysis.classifier}`,
  ].join('\n');
}
