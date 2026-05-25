import { spawn } from 'child_process';
import * as path from 'path';

export interface RouterResult {
  continue?: boolean;
  modifiedParameters?: {
    userMessage?: string;
  };
  hookSpecificOutput?: string;
  decision?: string;
  reason?: string;
}

const ROUTER_RELATIVE_PATH = path.join('.github', 'hooks', 'scripts', 'maestro-router.js');

// 라우터가 stdout으로 single-line JSON을 쓰지만, 안전을 위해 마지막 JSON 객체를 찾는다.
function parseRouterStdout(raw: string): RouterResult {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('maestro-router stdout이 비어있음');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error(`maestro-router JSON 파싱 실패: ${trimmed.slice(0, 200)}`);
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

export async function callMaestroRouter(
  prompt: string,
  workspaceRoot: string,
  timeoutMs = 15_000,
): Promise<RouterResult> {
  const routerPath = path.join(workspaceRoot, ROUTER_RELATIVE_PATH);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [routerPath], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        USER_PROMPT: prompt,
        AGENT_NAME: 'Maestro',
        SUBAGENT_NAME: '',
      },
      // stdin을 ignore로 두면 자식 코드가 stdin을 await할 일이 없어 Windows libuv assert 회피.
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
      // Windows에서 fetch/async 정리 도중 libuv assert로 non-zero exit이 나도
      // stdout이 완전한 JSON이면 데이터는 유효하다. 파싱이 성공하면 우선한다.
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

// userMessage 안에 묻혀있는 디스크 배지 블록(```\n🎯 ... 📋 ... 🔍 ...\n```)을 추출.
// 블록을 못 찾으면 빈 문자열을 돌려준다 (호출자가 처리).
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
