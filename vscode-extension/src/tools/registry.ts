import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { displayRelativePath, HarnessPaths, resolveWorkspacePath } from '../state/paths';
import { checkCommand, checkFileWrite } from './guards';
import { appendPipelineStep } from '../state/pipeline-log';
import { determineTestResult, isTestCommand, markFileChanged, recordTestEvidence } from '../state/test-gate';
import { redactSecrets } from '../state/redaction';
import { AGENT_TOOL_NAME, getActiveInvokerContext, InvokeAgentInput, invokeAgent, setActiveInvokerContext } from './agent-tool';

/**
 * vscode.lm 도구 registry.
 *
 * executor가 각 agent LLM 호출에 이 도구들을 전달한다. 모든 쓰기/실행 도구는
 * meta/guards.json SSOT를 먼저 확인하고, deny 판정이면 실행하지 않는다.
 */

type ResolverFn = () => HarnessPaths | string | null;

export const MAESTRO_TOOL_NAMES = [
  'maestro_read_file',
  'maestro_list_files',
  'maestro_search_files',
  'maestro_write_file',
  'maestro_run_terminal',
];

export const MAESTRO_READONLY_TOOL_NAMES = [
  'maestro_read_file',
  'maestro_list_files',
  'maestro_search_files',
];

/** single-session 모드에서 outer LLM이 사용할 서브에이전트 호출 도구 이름. */
export const MAESTRO_INVOKE_AGENT_TOOL_NAME = AGENT_TOOL_NAME;

/** single-session 시작/종료 시 extension이 호출해 모델 컨텍스트를 주입/정리한다. */
export { setActiveInvokerContext };

interface ReadFileInput {
  path: string;
  maxBytes?: number;
}

interface ListFilesInput {
  root?: string;
  maxFiles?: number;
}

interface SearchFilesInput {
  pattern: string;
  root?: string;
  include?: string;
  maxMatches?: number;
  regex?: boolean;
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
  return typeof p === 'string' ? new HarnessPaths(p) : p;
}

function denyOutsideMessage(inputPath: string): string {
  return `거부: configured workspace roots 외부 경로 (${inputPath})`;
}

function shouldSkipDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'out' || name === 'dist';
}

function walkFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function literalToRegExp(pattern: string): RegExp {
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

const MAX_CMD_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

function execCommand(executable: string, args: string[], cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
      if (stdout.length + stderr.length > MAX_CMD_OUTPUT_BYTES && !killed) {
        killed = true;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stdout.length + stderr.length > MAX_CMD_OUTPUT_BYTES && !killed) {
        killed = true;
        child.kill();
      }
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr: killed ? stderr + '\n[출력 크기 초과로 프로세스 종료됨]' : stderr,
      });
    });
  });
}

export function registerTools(
  context: vscode.ExtensionContext,
  resolver: ResolverFn,
): void {
  // -- read_file ----------------------------------------------------
  context.subscriptions.push(vscode.lm.registerTool<ReadFileInput>('maestro_read_file', {
    async invoke(opts, _token) {
      const paths = requireHarness(resolver);
      const resolved = resolveWorkspacePath(paths, opts.input.path);
      if (!resolved.allowed) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(resolved.symlinkBlocked ? '거부: symlink 경로는 허용하지 않습니다.' : denyOutsideMessage(opts.input.path)),
        ]);
      }
      try {
        const max = Math.min(opts.input.maxBytes ?? 100_000, 1_000_000);
        const stat = fs.statSync(resolved.abs);
        let content: string;
        if (stat.size > max) {
          const buf = Buffer.alloc(max);
          const fd = fs.openSync(resolved.abs, 'r');
          const bytesRead = fs.readSync(fd, buf, 0, max, 0);
          content = buf.slice(0, bytesRead).toString('utf8') + `\n...(${stat.size - max} 바이트 잘림)`;
        } else {
          content = fs.readFileSync(resolved.abs, 'utf8');
        }
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(content),
        ]);
      } catch (e) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`읽기 실패 (${opts.input.path}): ${(e as Error).message}`),
        ]);
      }
    },
  }));

  // -- list_files ---------------------------------------------------
  context.subscriptions.push(vscode.lm.registerTool<ListFilesInput>('maestro_list_files', {
    async invoke(opts, _token) {
      const paths = requireHarness(resolver);
      const requestedRoot = opts.input.root || '.';
      const resolved = resolveWorkspacePath(paths, requestedRoot);
      if (!resolved.allowed) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(resolved.symlinkBlocked ? '거부: symlink 경로는 허용하지 않습니다.' : denyOutsideMessage(requestedRoot)),
        ]);
      }
      const maxFiles = Math.min(Math.max(opts.input.maxFiles ?? 200, 1), 1000);
      const files = walkFiles(resolved.abs, maxFiles).map(f => displayRelativePath(paths, f));
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(files.join('\n') || '(파일 없음)'),
      ]);
    },
  }));

  // -- search_files -------------------------------------------------
  context.subscriptions.push(vscode.lm.registerTool<SearchFilesInput>('maestro_search_files', {
    async invoke(opts, _token) {
      const paths = requireHarness(resolver);
      const requestedRoot = opts.input.root || '.';
      const resolved = resolveWorkspacePath(paths, requestedRoot);
      if (!resolved.allowed) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(resolved.symlinkBlocked ? '거부: symlink 경로는 허용하지 않습니다.' : denyOutsideMessage(requestedRoot)),
        ]);
      }
      let regex: RegExp;
      try {
        regex = opts.input.regex === true ? new RegExp(opts.input.pattern, 'i') : literalToRegExp(opts.input.pattern);
      } catch (e) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`검색 패턴 오류: ${(e as Error).message}`),
        ]);
      }
      const include = opts.input.include ? wildcardToRegExp(opts.input.include) : null;
      const maxMatches = Math.min(Math.max(opts.input.maxMatches ?? 100, 1), 500);
      const maxFileBytes = 1_000_000;
      const matches: string[] = [];
      for (const file of walkFiles(resolved.abs, 2000)) {
        const rel = displayRelativePath(paths, file);
        if (include && !include.test(path.basename(rel))) continue;
        let text = '';
        try {
          const stat = fs.statSync(file);
          if (stat.size > maxFileBytes) continue;
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue;
          matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 240)}`);
          if (matches.length >= maxMatches) break;
        }
        if (matches.length >= maxMatches) break;
      }
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(matches.join('\n') || '(검색 결과 없음)'),
      ]);
    },
  }));

  // -- write_file ---------------------------------------------------
  context.subscriptions.push(vscode.lm.registerTool<WriteFileInput>('maestro_write_file', {
    async prepareInvocation(opts, _token) {
      const paths = requireHarness(resolver);
      const check = checkFileWrite(paths, opts.input.path);
      const confirmationMessages = check.decision === 'allow' ? undefined : {
        title: `파일 쓰기 확인 - ${check.decision.toUpperCase()}`,
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
      const resolved = resolveWorkspacePath(paths, opts.input.path);
      if (!resolved.allowed) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(resolved.symlinkBlocked ? '거부: symlink 경로는 허용하지 않습니다.' : denyOutsideMessage(opts.input.path)),
        ]);
      }
      try {
        fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
        fs.writeFileSync(resolved.abs, opts.input.content, 'utf8');
        markFileChanged(paths, 'maestro_write_file', resolved.abs);
        appendPipelineStep(paths, {
          step: 'tool:maestro_write_file',
          output: `쓰기 완료: ${resolved.rel}`,
          extra: { toolName: 'maestro_write_file', path: resolved.rel, chars: opts.input.content.length },
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

  // -- run_terminal -------------------------------------------------
  context.subscriptions.push(vscode.lm.registerTool<RunTerminalInput>('maestro_run_terminal', {
    async prepareInvocation(opts, _token) {
      const paths = requireHarness(resolver);
      let cwd = paths.workspaceRoot;
      if (opts.input.cwd) {
        const resolved = resolveWorkspacePath(paths, opts.input.cwd);
        if (resolved.allowed) cwd = resolved.abs;
      }
      const check = checkCommand(paths, opts.input.command, cwd);
      const confirmationMessages = check.decision === 'allow' ? undefined : {
        title: '터미널 명령 거부',
        message: new vscode.MarkdownString(
          `명령: \`${redactSecrets(opts.input.command)}\`\n\n사유: ${check.reason || check.matched.join(', ') || 'not allowed'}\n\n` +
          `> ⛔ Maestro 터미널 도구는 allowlist된 테스트 명령만 실행합니다.`,
        ),
      };
      return {
        invocationMessage: `터미널 실행: ${opts.input.command.slice(0, 60)}${opts.input.command.length > 60 ? '...' : ''}`,
        confirmationMessages,
      };
    },
    async invoke(opts, _token) {
      const paths = requireHarness(resolver);
      let cwd = paths.workspaceRoot;
      if (opts.input.cwd) {
        const resolved = resolveWorkspacePath(paths, opts.input.cwd);
        if (!resolved.allowed) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(resolved.symlinkBlocked ? '거부: symlink cwd는 허용하지 않습니다.' : `거부: configured workspace roots 외부 cwd (${opts.input.cwd})`),
          ]);
        }
        cwd = resolved.abs;
      }

      const check = checkCommand(paths, opts.input.command, cwd);
      if (check.decision === 'deny' || !check.executable || !check.args) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`거부: ${check.reason || check.matched.join(', ') || 'allowlist에 없는 명령'}`),
        ]);
      }

      const result = await execCommand(check.executable, check.args, cwd);
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      if (isTestCommand(opts.input.command)) {
        const testResult = determineTestResult(result.exitCode, combined);
        recordTestEvidence(paths, {
          command: check.canonical || opts.input.command,
          result: testResult,
          status: testResult,
          exitCode: result.exitCode,
          evidence: redactSecrets(combined.split('\n').slice(-40).join('\n')),
        });
      }
      appendPipelineStep(paths, {
        step: 'tool:maestro_run_terminal',
        output: redactSecrets(combined.slice(0, 4000)),
        extra: { toolName: 'maestro_run_terminal', command: check.canonical || opts.input.command, exitCode: result.exitCode },
      });
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `exitCode=${result.exitCode}\n\nSTDOUT:\n${redactSecrets(result.stdout) || '(empty)'}\n\nSTDERR:\n${redactSecrets(result.stderr) || '(empty)'}`,
        ),
      ]);
    },
  }));

  // -- invoke_agent (single-session 전용) ---------------------------
  context.subscriptions.push(vscode.lm.registerTool<InvokeAgentInput>(AGENT_TOOL_NAME, {
    async prepareInvocation(opts, _token) {
      const name = opts.input.agent_name || '(없음)';
      return {
        invocationMessage: `에이전트 호출: ${name}`,
      };
    },
    async invoke(opts, token) {
      const result = await invokeAgent(opts.input, token, getActiveInvokerContext());
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(result),
      ]);
    },
  }));
}


