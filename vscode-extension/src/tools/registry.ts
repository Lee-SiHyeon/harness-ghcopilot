import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { HarnessPaths } from '../state/paths';
import { checkCommand, checkFileWrite } from './guards';
import { appendPipelineStep } from '../state/pipeline-log';
import { determineTestResult, isTestCommand, markFileChanged, recordTestEvidence } from '../state/test-gate';

/**
 * vscode.lm 도구 registry.
 *
 * executor가 각 agent LLM 호출에 이 도구들을 전달한다. 모든 쓰기/실행 도구는
 * meta/guards.json SSOT를 먼저 확인하고, deny 판정이면 실행하지 않는다.
 */

type ResolverFn = () => string | null;

export const MAESTRO_TOOL_NAMES = [
  'maestro_read_file',
  'maestro_write_file',
  'maestro_run_terminal',
];

interface ReadFileInput {
  path: string;
  maxBytes?: number;
}

interface WriteFileInput {
  path: string;
  content: string;
}

interface RunTerminalInput {
  command: string;
  cwd?: string;
}

function requireHarness(resolver: ResolverFn): HarnessPaths {
  const p = resolver();
  if (!p) throw new Error('Maestro harness(.github)를 찾을 수 없습니다.');
  return new HarnessPaths(p);
}

function harnessRoot(paths: HarnessPaths): string {
  return path.dirname(path.resolve(paths.harnessPath));
}

function resolveInsideHarnessRoot(paths: HarnessPaths, targetPath: string): { abs: string; rel: string } {
  const root = harnessRoot(paths);
  const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
  const rel = path.relative(root, abs);
  return { abs, rel };
}

function isOutsideHarnessRoot(rel: string): boolean {
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function execCommand(command: string, cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    exec(command, { cwd, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
      const anyErr = err as NodeJS.ErrnoException & { code?: number };
      resolve({
        exitCode: typeof anyErr?.code === 'number' ? anyErr.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

export function registerTools(
  context: vscode.ExtensionContext,
  resolver: ResolverFn,
): void {
  // ── read_file ────────────────────────────────────────────────────
  context.subscriptions.push(vscode.lm.registerTool<ReadFileInput>('maestro_read_file', {
    async invoke(opts, _token) {
      const paths = requireHarness(resolver);
      const { abs, rel } = resolveInsideHarnessRoot(paths, opts.input.path);
      if (isOutsideHarnessRoot(rel)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`거부: workspace 외부 경로 (${opts.input.path})`),
        ]);
      }
      try {
        const buf = fs.readFileSync(abs);
        const max = Math.min(opts.input.maxBytes ?? 100_000, 1_000_000);
        const slice = buf.subarray(0, max);
        const text = slice.toString('utf8');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            buf.length > max
              ? `${text}\n\n…(${buf.length - max} bytes 잘림)`
              : text,
          ),
        ]);
      } catch (e) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`읽기 실패 (${opts.input.path}): ${(e as Error).message}`),
        ]);
      }
    },
  }));

  // ── write_file ───────────────────────────────────────────────────
  context.subscriptions.push(vscode.lm.registerTool<WriteFileInput>('maestro_write_file', {
    async prepareInvocation(opts, _token) {
      const paths = requireHarness(resolver);
      const check = checkFileWrite(paths, opts.input.path);
      const confirmationMessages = check.decision === 'allow' ? undefined : {
        title: `파일 쓰기 확인 — ${check.decision.toUpperCase()}`,
        message: new vscode.MarkdownString(
          `대상: \`${opts.input.path}\`\n\n사유: ${check.reason || '(없음)'}\n\n` +
          `${check.decision === 'deny' ? '> ⛔ 가드가 거부했습니다. 진행하려면 명시적으로 승인하세요.' : '> 보호된 위치입니다.'}`,
        ),
      };
      return {
        invocationMessage: `${opts.input.path} 쓰기`,
        confirmationMessages,
      };
    },
    async invoke(opts, _token) {
      const paths = requireHarness(resolver);
      const check = checkFileWrite(paths, opts.input.path);
      if (check.decision === 'deny') {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`거부: ${check.reason}`),
        ]);
      }
      const { abs, rel } = resolveInsideHarnessRoot(paths, opts.input.path);
      if (isOutsideHarnessRoot(rel)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`거부: workspace 외부 경로 (${opts.input.path})`),
        ]);
      }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, opts.input.content, 'utf8');
        markFileChanged(paths, 'maestro_write_file', abs);
        appendPipelineStep(paths, {
          step: 'tool:maestro_write_file',
          output: `쓰기 완료: ${rel}`,
          extra: { toolName: 'maestro_write_file', path: rel, chars: opts.input.content.length },
        });
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`쓰기 완료: ${opts.input.path} (${opts.input.content.length} chars)`),
        ]);
      } catch (e) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`쓰기 실패: ${(e as Error).message}`),
        ]);
      }
    },
  }));

  // ── run_terminal ─────────────────────────────────────────────────
  context.subscriptions.push(vscode.lm.registerTool<RunTerminalInput>('maestro_run_terminal', {
    async prepareInvocation(opts, _token) {
      const paths = requireHarness(resolver);
      const check = checkCommand(paths, opts.input.command);
      const confirmationMessages = check.decision === 'allow' ? undefined : {
        title: '파괴적 명령 감지 — 사용자 확인 필요',
        message: new vscode.MarkdownString(
          `명령: \`${opts.input.command}\`\n\n매칭 패턴: ${check.matched.map(m => '`' + m + '`').join(', ')}\n\n` +
          `> ⛔ 가드가 deny 판정했습니다. 진행하려면 명시적으로 승인하세요.`,
        ),
      };
      return {
        invocationMessage: `터미널 실행: ${opts.input.command.slice(0, 60)}${opts.input.command.length > 60 ? '…' : ''}`,
        confirmationMessages,
      };
    },
    async invoke(opts, _token) {
      const paths = requireHarness(resolver);
      const check = checkCommand(paths, opts.input.command);
      if (check.decision === 'deny') {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`거부: 파괴적 명령 감지 (${check.matched.join(', ')})`),
        ]);
      }
      const root = harnessRoot(paths);
      let cwd = root;
      if (opts.input.cwd) {
        const resolved = resolveInsideHarnessRoot(paths, opts.input.cwd);
        if (isOutsideHarnessRoot(resolved.rel)) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`거부: workspace 외부 cwd (${opts.input.cwd})`),
          ]);
        }
        cwd = resolved.abs;
      }
      const result = await execCommand(opts.input.command, cwd);
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      if (isTestCommand(opts.input.command)) {
        const testResult = determineTestResult(result.exitCode, combined);
        recordTestEvidence(paths, {
          command: opts.input.command,
          result: testResult,
          status: testResult,
          exitCode: result.exitCode,
          evidence: combined.split('\n').slice(-40).join('\n'),
        });
      }
      appendPipelineStep(paths, {
        step: 'tool:maestro_run_terminal',
        output: combined.slice(0, 4000),
        extra: { toolName: 'maestro_run_terminal', command: opts.input.command, exitCode: result.exitCode },
      });
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `exitCode=${result.exitCode}\n\nSTDOUT:\n${result.stdout || '(empty)'}\n\nSTDERR:\n${result.stderr || '(empty)'}`,
        ),
      ]);
    },
  }));
}
