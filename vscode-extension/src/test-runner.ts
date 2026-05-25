import { spawn } from 'child_process';

export interface NpmTestRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface NpmTestSpawnSpec {
  command: string;
  args: string[];
  shell: false;
}

export function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function npmTestSpawnSpec(): NpmTestSpawnSpec {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', npmExecutable(), 'test'], shell: false };
  }

  return { command: npmExecutable(), args: ['test'], shell: false };
}

export function runNpmTest(
  cwd: string,
  timeoutMs = 180_000,
  spec: NpmTestSpawnSpec = npmTestSpawnSpec(),
): Promise<NpmTestRunResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? 1 : exitCode, stdout, stderr, timedOut });
    };
    const child = spawn(spec.command, spec.args, { cwd, shell: spec.shell, windowsHide: true });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', err => {
      stderr += err.message;
      finish(1);
    });
    child.on('close', code => {
      finish(code);
    });
  });
}