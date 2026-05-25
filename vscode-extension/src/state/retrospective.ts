import * as fs from 'fs';
import { HarnessPaths } from './paths';
import { appendActionItems, updateRetrospectiveDraft, ActionItem } from './action-items';
import { getGateState, isEvidenceValid } from './test-gate';
import type { StepResult } from '../pipeline/executor';

const ACTION_TEMPLATES: Record<string, string> = {
  Tester: 'implement/fix 파이프라인에서 Tester 호출 필수 — 다음 Reviewer 호출 전 확인',
  Reviewer: 'Reviewer 승인 없이 파이프라인 종료 금지 — 재실행 필요',
  Planner: 'Planner 건너뜀 — 다음 실행 시 설계 검증 단계 추가',
  Investigator: 'fix 파이프라인 시작 전 Investigator 완료 필수',
  Documenter: 'Documenter 단계 누락 — 문서화 후속 작업 확인',
  Release: 'Release 단계 누락 — 변경 사항 미커밋. 다음 실행 시 Release 포함 필수',
  Critic: 'Critic 미실행 — 파이프라인 준수 감사 없이 종료됨. 다음 실행 시 Critic 포함 필수',
};

export function buildPipelineActionItems(
  intent: string,
  plannedPipeline: string[],
  results: StepResult[],
  paths?: HarnessPaths,
): ActionItem[] {
  const ts = new Date().toISOString();
  const executed = results.filter(r => !r.skipped).map(r => r.agentName);
  const items: ActionItem[] = [];
  for (const agent of plannedPipeline) {
    if (!executed.includes(agent)) {
      items.push({
        source: 'skippedAgent',
        agent,
        message: ACTION_TEMPLATES[agent] || `${agent} 에이전트 건너뜀 — 다음 실행 시 포함 확인`,
        ts,
      });
    }
  }
  if ((intent === 'implement' || intent === 'fix') && !executed.includes('Tester')) {
    items.push({ source: 'absentAgent', agent: 'Tester', message: ACTION_TEMPLATES.Tester, ts });
  }
  if (!executed.includes('Critic')) {
    items.push({ source: 'absentAgent', agent: 'Critic', message: ACTION_TEMPLATES.Critic, ts });
  }
  if (paths) {
    const gate = getGateState(paths);
    if (gate.requiredSince && !isEvidenceValid(paths)) {
      items.push({
        source: 'testGate',
        agent: 'Tester',
        message: '파일 변경 후 유효한 PASS 테스트 증거가 없음 — 다음 응답 전에 Tester/테스트 명령 실행 필수',
        ts,
      });
    }
  }
  return items;
}

export function finalizeRetrospective(
  paths: HarnessPaths,
  args: {
    sessionId: string;
    intent: string;
    plannedPipeline: string[];
    results: StepResult[];
    durationMs: number | null;
  },
): void {
  const executedAgents = args.results.filter(r => !r.skipped).map(r => r.agentName);
  const skippedAgents = args.plannedPipeline.filter(a => !executedAgents.includes(a));
  const actionItems = buildPipelineActionItems(args.intent, args.plannedPipeline, args.results, paths);
  updateRetrospectiveDraft(paths, {
    sessionId: args.sessionId,
    terminalAgent: executedAgents[executedAgents.length - 1] || 'Maestro',
    intent: args.intent,
    plannedPipeline: args.plannedPipeline,
    executedAgents,
    skippedAgents,
    durationMs: args.durationMs,
  });
  appendActionItems(paths, actionItems);

  const today = new Date().toISOString().slice(0, 10);
  const record = {
    v: 1,
    date: today,
    title: args.intent || 'unknown',
    type: args.intent || 'unknown',
    pipeline: args.plannedPipeline.join('→'),
    executed: executedAgents.map(a => `${a} ✅`).join(' → ') || '(기록 없음)',
    skipped: skippedAgents.join(', ') || '없음',
    repeatIssue: '',
    selfCritique: '(Maestro 기입 필요)',
    nextImprovement: '(Maestro 기입 필요)',
    ts: new Date().toISOString(),
    sessionId: args.sessionId,
  };
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    fs.appendFileSync(paths.retroJsonlPath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}
