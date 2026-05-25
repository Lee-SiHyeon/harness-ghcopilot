import { execFileSync } from 'child_process';
import * as path from 'path';

export interface GitChangeReport {
  cwd: string;
  branch: string;
  status: string;
  unstagedStat: string;
  stagedStat: string;
  recentCommits: string;
}

const CHANGE_QUERY_RE =
  /(변경|바뀐|수정|diff|커밋|commit|status|작업\s*내역|뭐\s*바뀜|들어온\s*게|들어온게)/i;

export function isGitChangeQuery(prompt: string): boolean {
  return CHANGE_QUERY_RE.test(prompt);
}

function runGit(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (allowFailure) return '';
    throw e;
  }
}

export function findGitCwd(harnessPath: string): string | null {
  const parent = path.dirname(path.resolve(harnessPath));
  const candidates = [parent, path.resolve(harnessPath)];
  for (const cwd of candidates) {
    const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], true);
    if (inside === 'true') return cwd;
  }
  return null;
}

export function inspectGitChanges(harnessPath: string): GitChangeReport | null {
  const cwd = findGitCwd(harnessPath);
  if (!cwd) return null;
  return {
    cwd,
    branch: runGit(cwd, ['branch', '--show-current'], true) || '(detached HEAD)',
    status: runGit(cwd, ['status', '--short'], true),
    unstagedStat: runGit(cwd, ['diff', '--stat'], true),
    stagedStat: runGit(cwd, ['diff', '--cached', '--stat'], true),
    recentCommits: runGit(cwd, ['log', '--oneline', '-5'], true),
  };
}

function fenced(label: string, value: string): string {
  return value.trim()
    ? `**${label}**\n\n\`\`\`\n${value.trim()}\n\`\`\`\n`
    : `**${label}**\n\n없음\n`;
}

export function renderGitChangeReport(report: GitChangeReport): string {
  const parts = [
    `현재 git 기준 변경을 직접 확인했습니다.`,
    '',
    `- 기준 경로: \`${report.cwd}\``,
    `- 브랜치: \`${report.branch}\``,
    '',
    fenced('작업트리 상태', report.status),
    fenced('unstaged diff stat', report.unstagedStat),
    fenced('staged diff stat', report.stagedStat),
    fenced('최근 커밋 5개', report.recentCommits),
  ];
  return parts.join('\n');
}
