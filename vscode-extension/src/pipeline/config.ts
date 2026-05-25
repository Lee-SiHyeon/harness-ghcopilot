import * as fs from 'fs';
import { HarnessPaths } from '../state/paths';

export interface PipelineDefinition {
  id: string;
  label: string;
  keywords?: string[];
  steps: string[];
}

export interface PipelineConfig {
  pipelines: PipelineDefinition[];
  defaultPipeline: string;
  maxReviewerRetries: number;
  maxTesterRetries: number;
}

const FALLBACK_CONFIG: PipelineConfig = {
  pipelines: [
    { id: 'A', label: '신규 기능 구현', steps: ['Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'] },
    { id: 'B', label: '버그 수정', steps: ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'] },
    { id: 'C', label: '리팩토링', steps: ['Planner', 'Implementer', 'Reviewer', 'Critic', 'Release'] },
    { id: 'D', label: '문서화', steps: ['Context7 Docs Agent', 'Documenter', 'Critic', 'Release'] },
    { id: 'E', label: '코드 리뷰', steps: ['Reviewer', 'Critic', 'Release'] },
    { id: 'F', label: '라이브러리 질문', steps: ['Context7 Docs Agent'] },
    { id: 'G', label: '계획만 필요', steps: ['Planner', 'Critic', 'Release'] },
    { id: 'H', label: '릴리즈/배포', steps: ['Release', 'Critic'] },
    { id: 'I', label: '자기개선 탐색', steps: ['Scout', 'Critic', 'Release'] },
    { id: 'J', label: 'Scout 자기교정 루프', steps: ['Scout', 'Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'] },
    { id: 'K', label: '읽기 전용 코드 분석', steps: ['Inspector'] },
  ],
  defaultPipeline: 'A',
  maxReviewerRetries: 3,
  maxTesterRetries: 3,
};

export function loadPipelineConfig(paths: HarnessPaths): PipelineConfig {
  try {
    const raw = fs.readFileSync(paths.meta('pipelines.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pipelines: Array.isArray(parsed.pipelines) ? parsed.pipelines : FALLBACK_CONFIG.pipelines,
      defaultPipeline: parsed.defaultPipeline || FALLBACK_CONFIG.defaultPipeline,
      maxReviewerRetries: Number.isFinite(parsed.maxReviewerRetries) ? parsed.maxReviewerRetries : 3,
      maxTesterRetries: Number.isFinite(parsed.maxTesterRetries) ? parsed.maxTesterRetries : 3,
    };
  } catch {
    return FALLBACK_CONFIG;
  }
}

export function normalizePipeline(intent: string, pipeline: string[]): string[] {
  let steps = [...pipeline];
  if (!requiresAuditAndRelease(intent) && intent !== 'release') {
    steps = steps.filter(step => step !== 'Critic' && step !== 'Release');
  }
  if ((intent === 'implement' || intent === 'fix') && !steps.includes('Tester')) {
    const reviewerIdx = steps.indexOf('Reviewer');
    if (reviewerIdx >= 0) steps.splice(reviewerIdx, 0, 'Tester');
    else steps.push('Tester');
  }
  if (requiresAuditAndRelease(intent)) {
    if (!steps.includes('Critic')) steps.push('Critic');
    if (!steps.includes('Release')) steps.push('Release');
  }
  if (intent === 'release') {
    steps = ['Release', 'Critic'];
  }
  return dedupePreserveOrder(steps);
}

export function requiresAuditAndRelease(intent: string): boolean {
  return ['implement', 'fix', 'document', 'scout_loop'].includes(intent);
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
