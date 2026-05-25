import * as fs from 'fs';
import * as path from 'path';

/**
 * harness 부모 디렉토리의 .env 를 라인 단위로 read/update.
 *
 * - 기존 .env 라인 순서·주석·빈줄 보존
 * - 동일 키가 여러 번 정의돼 있으면 첫 번째만 갱신 (나머지 유지)
 * - 키가 없으면 파일 끝에 새로 append
 * - 따옴표는 가능한 한 원본 유지하되, 값에 공백·#가 포함되면 강제로 큰따옴표 처리
 */

export interface EnvUpdateResult {
  envPath: string;
  existed: boolean;
  keyExisted: boolean;
  written: boolean;
}

export function envPathFor(harnessPath: string): string {
  // router도 spawn cwd = parent로 사용. 같은 위치에 .env를 둔다.
  return path.join(path.dirname(path.resolve(harnessPath)), '.env');
}

function readLines(envPath: string): { lines: string[]; existed: boolean } {
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    return { lines: raw.split(/\r?\n/), existed: true };
  } catch {
    return { lines: [], existed: false };
  }
}

function quoteValue(value: string): string {
  if (value === '') return '';
  if (/[\s#"'\\]/.test(value)) {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return value;
}

const KEY_RE = (key: string) =>
  new RegExp('^\\s*(?:export\\s+)?' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');

export function getEnvValue(envPath: string, key: string): string | null {
  const { lines } = readLines(envPath);
  const re = KEY_RE(key);
  for (const line of lines) {
    if (re.test(line)) {
      const after = line.split('=').slice(1).join('=').trim();
      // 따옴표 제거
      if ((after.startsWith('"') && after.endsWith('"')) ||
          (after.startsWith("'") && after.endsWith("'"))) {
        return after.slice(1, -1);
      }
      // 주석 제거
      return after.replace(/\s+#.*$/, '').trim();
    }
  }
  return null;
}

export function setEnvValue(envPath: string, key: string, value: string): EnvUpdateResult {
  const { lines, existed } = readLines(envPath);
  const re = KEY_RE(key);
  let keyExisted = false;
  const newLines = lines.map(line => {
    if (!keyExisted && re.test(line)) {
      keyExisted = true;
      return `${key}=${quoteValue(value)}`;
    }
    return line;
  });
  if (!keyExisted) {
    if (newLines.length > 0 && newLines[newLines.length - 1] !== '') {
      newLines.push('');
    }
    newLines.push(`${key}=${quoteValue(value)}`);
  }
  // 항상 마지막 newline 보장
  let body = newLines.join('\n');
  if (!body.endsWith('\n')) body += '\n';

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, body, 'utf8');
  return { envPath, existed, keyExisted, written: true };
}

export function clearEnvValue(envPath: string, key: string): EnvUpdateResult {
  const { lines, existed } = readLines(envPath);
  if (!existed) {
    return { envPath, existed, keyExisted: false, written: false };
  }
  const re = KEY_RE(key);
  let removed = false;
  const filtered = lines.filter(line => {
    if (re.test(line)) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) {
    return { envPath, existed, keyExisted: false, written: false };
  }
  let body = filtered.join('\n');
  if (!body.endsWith('\n')) body += '\n';
  fs.writeFileSync(envPath, body, 'utf8');
  return { envPath, existed, keyExisted: true, written: true };
}
