import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HarnessPaths } from '../state/paths';
import { checkCommand, checkFileWrite } from './guards';

/**
 * vscode.lm 도구 스캐폴딩 — 단계적 이주.
 *
 * Phase 3에서 등록만 하고 executor에서 실제 사용은 Phase 3.5로 미룬다.
 * (executor에 tool-calling 통합은 별도 PR로 깔끔하게 분리)
 *
 * 모든 도구는 가드를 먼저 호출하고, deny면 PreparedToolInvocation으로
 * 사용자에게 명시적 확인을 요구한다.
 */

type ResolverFn = () => string | null;

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

export function registerTools(
  context: vscode.ExtensionContext,
  resolver: ResolverFn,
): void {
  // ── read_file ────────────────────────────────────────────────────
  context.subscriptions.push(vscode.lm.registerTool<ReadFileInput>('maestro_read_file', {
    async invoke(opts, _token) {
      const paths = requireHarness(resolver);
      const harnessRoot = path.dirname(path.resolve(paths.harnessPath));
      const abs = path.resolve(harnessRoot, opts.input.path);
      const rel = path.relative(harnessRoot, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
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
      const harnessRoot = path.dirname(path.resolve(paths.harnessPath));
      const abs = path.resolve(harnessRoot, opts.input.path);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, opts.input.content, 'utf8');
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
      // Phase 3에서는 실제 실행 대신 VS Code 터미널을 열어 사용자에게 보여준다.
      // 실제 execSync는 Phase 4에서 결과 캡처와 함께 도입.
      const terminal = vscode.window.createTerminal({
        name: 'Maestro',
        cwd: opts.input.cwd,
      });
      terminal.show();
      terminal.sendText(opts.input.command, false);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `명령을 터미널에 입력했습니다 (자동 실행하지 않음): \`${opts.input.command}\`. ` +
          `Enter를 눌러 실행하세요. Phase 4에서 자동 실행 + 결과 캡처가 도입됩니다.`,
        ),
      ]);
    },
  }));
}
