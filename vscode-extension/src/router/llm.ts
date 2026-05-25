import { envPathFor, getEnvValue } from '../env-file';
import { HarnessPaths } from '../state/paths';
import { normalizePipeline, requiresAuditAndRelease } from '../pipeline/config';
import { InternalAnalysis } from './internal';

const GITHUB_MODELS_URL = 'https://models.inference.ai.azure.com/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

const VALID_INTENTS = new Set([
  'implement', 'fix', 'investigate', 'review', 'inspect', 'document',
  'plan', 'question', 'query', 'release', 'scout', 'scout_loop',
]);

const PIPELINE_MAP: Record<string, string[]> = {
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

const SYSTEM_PROMPT = [
  'You classify user requests for Maestro, a VS Code multi-agent coding harness.',
  'Return ONLY a JSON object. No markdown.',
  'Schema: {"intent":"inspect","complexity":2,"scope":"single","security":[],"stacks":[],"task_count":1,"pipeline":["Inspector"],"needs_todo":false,"reason":"Korean one sentence"}',
  'intent must be one of: implement, fix, investigate, review, inspect, document, plan, question, query, release, scout, scout_loop.',
  'Use inspect for "what is missing/lacking/problematic in this project/extension" read-only gap analysis.',
  'Use question/query with empty pipeline for simple conversation or direct answers.',
  'Use fix for requested code changes, bugs, broken behavior, missing wiring, or "improve/fix it".',
  'Use implement for new features or broad improvements.',
  'Use release only for explicit commit/push/release/deploy requests.',
  'Allowed agents: Context7 Docs Agent, Planner, Implementer, Tester, Reviewer, Documenter, Investigator, Inspector, Release, Critic, Scout.',
].join('\n');

export interface LlmRouterResult {
  analysis: InternalAnalysis | null;
  used: boolean;
  reason: string;
  model?: string;
}

export async function classifyPromptWithGitHubModels(
  prompt: string,
  paths: HarnessPaths,
  timeoutMs: number,
): Promise<LlmRouterResult> {
  const pat = getEnvValue(envPathFor(paths.harnessPath), 'GITHUB_PAT') || process.env.GITHUB_PAT || '';
  if (!pat) return { analysis: null, used: false, reason: 'GITHUB_PAT missing' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(GITHUB_MODELS_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt.slice(0, 4000) },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
    });
    if (!res.ok) return { analysis: null, used: true, reason: `GitHub Models HTTP ${res.status}`, model: DEFAULT_MODEL };
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content || '';
    const parsed = parseRouterJson(text);
    if (!parsed) return { analysis: null, used: true, reason: 'GitHub Models JSON parse failed', model: DEFAULT_MODEL };
    return { analysis: normalizeLlmAnalysis(parsed, paths), used: true, reason: 'GitHub Models success', model: DEFAULT_MODEL };
  } catch (e) {
    const reason = controller.signal.aborted
      ? 'GitHub Models timeout'
      : `GitHub Models error: ${e instanceof Error ? e.message : String(e)}`;
    return { analysis: null, used: true, reason, model: DEFAULT_MODEL };
  } finally {
    clearTimeout(timer);
  }
}

function parseRouterJson(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```json?/g, '').replace(/```/g, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizeLlmAnalysis(raw: Record<string, unknown>, paths: HarnessPaths): InternalAnalysis {
  const rawIntent = typeof raw.intent === 'string' ? raw.intent : 'query';
  const intent = VALID_INTENTS.has(rawIntent) ? rawIntent : 'query';
  const rawPipeline = Array.isArray(raw.pipeline)
    ? raw.pipeline.filter((v): v is string => typeof v === 'string')
    : PIPELINE_MAP[intent] || [];
  const pipeline = normalizePipeline(intent, rawPipeline.length > 0 ? rawPipeline : PIPELINE_MAP[intent] || []);
  const complexityRaw = typeof raw.complexity === 'number' ? raw.complexity : 0;
  const complexity = Math.min(Math.max(Math.round(complexityRaw), 0), 10);
  const scope = raw.scope === 'multi' || raw.scope === 'architecture' ? raw.scope : 'single';
  const security = Array.isArray(raw.security) ? raw.security.filter((v): v is string => typeof v === 'string') : [];
  const stacks = Array.isArray(raw.stacks) ? raw.stacks.filter((v): v is string => typeof v === 'string') : [];
  const taskCountRaw = typeof raw.task_count === 'number' ? raw.task_count : 1;
  const reason = typeof raw.reason === 'string' && raw.reason.trim()
    ? raw.reason.trim()
    : 'GitHub Models LLM classifier result';
  void paths;
  return {
    intent,
    complexity,
    scope,
    security,
    stacks,
    task_count: Math.min(Math.max(Math.round(taskCountRaw), 1), 10),
    pipeline,
    needs_todo: typeof raw.needs_todo === 'boolean' ? raw.needs_todo : requiresAuditAndRelease(intent) || complexity >= 3,
    reason: `[github-models-router] ${reason}`,
    classifier: 'GitHub Models LLM router',
  };
}
