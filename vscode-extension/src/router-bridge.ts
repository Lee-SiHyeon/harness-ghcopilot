import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface RouterResult {
  continue?: boolean;
  modifiedParameters?: {
    userMessage?: string;
  };
  hookSpecificOutput?: string;
  decision?: string;
  reason?: string;
}

export interface RouterCallOptions {
  /** Path to the `.github` (or harness) directory containing `hooks/scripts/maestro-router.js`. */
  harnessPath: string;
  /** Optional timeout in ms (default 15s). */
  timeoutMs?: number;
  /** Optional: extra env to pass through. */
  extraEnv?: NodeJS.ProcessEnv;
}

const ROUTER_REL = path.join('hooks', 'scripts', 'maestro-router.js');

function parseRouterStdout(raw: string): RouterResult {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('maestro-router stdout이 비어있음');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1) {
      throw new Error(`maestro-router JSON 파싱 실패: ${trimmed.slice(0, 200)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * harnessPath: `.github` 디렉토리 절대 경로.
 *
 * maestro-router.js는 `process.cwd() + '/.github/...'` 식으로 로그/SSOT를 찾는다.
 * 따라서 spawn cwd는 harness 폴더의 **부모**여야 하며, 부모 안에서 본 harness가
 * 정확히 `.github`라는 이름의 하위 폴더로 보여야 한다.
 *
 * 두 시나리오를 모두 지원:
 * 1. host project: harnessPath = `<project>/.github` → spawn cwd = `<project>`
 * 2. standalone clone: harnessPath = `<cloned>/.github` 형태로 폴더명이 `.github` →
 *    spawn cwd = `<cloned>` (부모)
 * 3. clone 후 폴더명이 `.github`가 아닌 경우(예: `dotgithub-harness/`) →
 *    임시 부모 폴더에 심볼릭 링크/리네임이 필요하므로 명시적으로 거부한다.
 */
export function deriveSpawnCwd(harnessPath: string): string {
  const normalized = path.resolve(harnessPath);
  const basename = path.basename(normalized);
  if (basename !== '.github') {
    throw new Error(
      `maestroChat.harnessPath의 마지막 폴더명이 ".github"가 아닙니다: "${basename}". ` +
      `라우터가 cwd/.github/... 구조를 가정하므로 폴더 이름을 ".github"로 유지해야 합니다.`
    );
  }
  return path.dirname(normalized);
}

export function routerScriptPath(harnessPath: string): string {
  return path.join(path.resolve(harnessPath), ROUTER_REL);
}

export async function callMaestroRouter(
  prompt: string,
  options: RouterCallOptions,
): Promise<RouterResult> {
  const { harnessPath, timeoutMs = 15_000, extraEnv } = options;
  const scriptPath = routerScriptPath(harnessPath);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`maestro-router.js를 찾을 수 없음: ${scriptPath}`);
  }
  const cwd = deriveSpawnCwd(harnessPath);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env: {
        ...process.env,
        USER_PROMPT: prompt,
        AGENT_NAME: 'Maestro',
        SUBAGENT_NAME: '',
        ...(extraEnv || {}),
      },
      // stdin=ignore → Windows libuv assert 회피, 자식이 stdin을 읽으려 해도 즉시 EOF
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`maestro-router timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      // Windows libuv assert로 non-zero exit이 나도 stdout이 valid JSON이면 데이터는 유효.
      try {
        const parsed = parseRouterStdout(stdout);
        resolve(parsed);
      } catch (parseErr) {
        if (code === 0) {
          reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
        } else {
          reject(new Error(
            `maestro-router exit ${code} and stdout unparseable. ` +
            `stderr: ${stderr.slice(0, 300)} | stdout head: ${stdout.slice(0, 200)}`
          ));
        }
      }
    });
  });
}

/** userMessage 안의 ```\n🎯 ... 📋 ...\n``` 블록을 추출. */
export function extractBadge(userMessage: string): string {
  if (!userMessage) return '';
  const fenceRe = /```\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(userMessage)) !== null) {
    const block = m[1];
    if (/^🎯 \*\*작업 유형\*\*/m.test(block) && /^📋 \*\*파이프라인\*\*/m.test(block)) {
      return block;
    }
  }
  return '';
}
