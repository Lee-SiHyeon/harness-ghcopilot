#!/usr/bin/env node
/**
 * Safety Guard — PreToolUse Hook
 *
 * run_in_terminal / execute_command 호출 전에 실행.
 * 파괴적 명령어 패턴을 감지하면 경고를 표시하고 사용자 확인을 요청한다.
 *
 * 환경변수:
 *   TOOL_NAME    호출된 도구 이름
 *   TOOL_INPUT   도구 입력 (JSON 문자열)
 */

'use strict';

const toolName  = process.env.TOOL_NAME  || '';
const toolInput = process.env.TOOL_INPUT || '{}';

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

let command = '';
try {
  const parsed = JSON.parse(toolInput);
  const cmdStr = parsed.command || parsed.cmd || '';
  const argsStr = Array.isArray(parsed.args)
    ? parsed.args.map(String).join(' ')
    : (typeof parsed.args === 'string' ? parsed.args : '');
  command = cmdStr || argsStr;
} catch {
  command = toolInput;
}

// ── 파괴적 명령 패턴 ─────────────────────────────────────────────
const DESTRUCTIVE_PATTERNS = [
  { re: /rm\s+-[rRfF]{1,4}\s/,     label: 'rm -rf (재귀 삭제)' },
  { re: /git\s+push\s+.*--force(?!-with-lease)/i, label: 'git push --force' },
  // force-with-lease는 원격 브랜치 보호 안전 메커니즘 — 위험 패턴에서 제외
  { re: /git\s+reset\s+--hard/i,  label: 'git reset --hard' },
  { re: /DROP\s+TABLE/i,           label: 'DROP TABLE (DB 테이블 삭제)' },
  { re: /DROP\s+DATABASE/i,        label: 'DROP DATABASE' },
  { re: /kubectl\s+(-n\s+\S+\s+)?delete/i, label: 'kubectl delete' },
  { re: /npx\s+prisma\s+migrate\s+reset/i, label: 'prisma migrate reset (DB 초기화)' },
  { re: />\s*\/dev\/null\s*2>&1.*&&\s*rm/i, label: '위험한 파이프 + 삭제 조합' },
  { re: /find\s+.*-delete\b/i,     label: 'find -delete (파일 일괄 삭제)' },
  { re: /find\s+.*-exec\s+rm\b/i,  label: 'find -exec rm (파일 일괄 삭제)' },
];

const matched = DESTRUCTIVE_PATTERNS.filter(p => p.re.test(command));

if (matched.length === 0) {
  // 안전 — 감사 로그만 남기고 조용히 continue
  const preview = command.length > 80 ? command.slice(0, 80) + '…' : command;
  tryAudit({ event: 'safety_guard', decision: 'allow', tool: toolName, commandPreview: preview.slice(0, 80) });
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

// 경고 표시 후 사용자 확인 요청
const labels = matched.map(m => `  ⚠️  ${m.label}`).join('\n');
const warning = [
  '## [Safety Guard] 파괴적 명령 감지',
  '',
  `실행 예정 명령어: \`${command}\``,
  '',
  '감지된 위험 패턴:',
  labels,
  '',
  '계속 진행하려면 **"yes, proceed"** 라고 답하거나, 취소하려면 **"cancel"** 이라고 답해줘.',
].join('\n');

tryAudit({ event: 'safety_guard', decision: 'ask', tool: toolName, patterns: matched.map(m => m.label) });

process.stdout.write(JSON.stringify({
  continue: false,
  decision: 'ask',
  reason: warning,
}));
