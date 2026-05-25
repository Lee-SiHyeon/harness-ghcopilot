import * as fs from 'fs';
import { HarnessPaths } from './paths';

export interface ActionItem {
  source?: string;
  agent?: string;
  message?: string;
  ts?: string;
}

interface DraftFile {
  actionItems?: ActionItem[];
  [k: string]: unknown;
}

const DRAFT_NAME = 'retrospective-draft.json';

function readDraft(paths: HarnessPaths): DraftFile {
  try {
    const raw = fs.readFileSync(paths.log(DRAFT_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDraft(paths: HarnessPaths, draft: DraftFile): void {
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    fs.writeFileSync(paths.log(DRAFT_NAME), JSON.stringify(draft, null, 2), 'utf8');
  } catch {
    /* 로그 쓰기 실패는 무시 — extension 동작은 계속 */
  }
}

export function loadActionItems(paths: HarnessPaths): ActionItem[] {
  const draft = readDraft(paths);
  return Array.isArray(draft.actionItems) ? draft.actionItems : [];
}

export function loadActionItemsCount(paths: HarnessPaths): number {
  return loadActionItems(paths).length;
}

/** Maestro가 actionItems를 소비한 뒤 호출 — 빈 배열로 reset. */
export function clearActionItems(paths: HarnessPaths): void {
  const draft = readDraft(paths);
  draft.actionItems = [];
  writeDraft(paths, draft);
}
