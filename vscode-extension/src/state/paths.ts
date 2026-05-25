import * as path from 'path';

/**
 * harnessPath 기반 경로 헬퍼 — 모든 state 파일은 harness/logs/ 아래.
 * spawn cwd는 harness의 부모이므로, hook scripts가 process.cwd()/.github/logs/...로
 * 접근하는 것과 같은 위치를 가리키게 된다.
 */
export class HarnessPaths {
  constructor(public readonly harnessPath: string) {}

  get logsDir(): string {
    return path.join(this.harnessPath, 'logs');
  }
  get agentsDir(): string {
    return path.join(this.harnessPath, 'agents');
  }
  get metaDir(): string {
    return path.join(this.harnessPath, 'meta');
  }
  log(name: string): string {
    return path.join(this.logsDir, name);
  }
  get testEvidencePath(): string {
    return this.log('test-evidence.json');
  }
  get testGateStatePath(): string {
    return this.log('test-gate-state.json');
  }
  get retrospectiveDraftPath(): string {
    return this.log('retrospective-draft.json');
  }
  get retroJsonlPath(): string {
    return this.log('retro.jsonl');
  }
  meta(name: string): string {
    return path.join(this.metaDir, name);
  }
  agent(filename: string): string {
    return path.join(this.agentsDir, filename);
  }
}
