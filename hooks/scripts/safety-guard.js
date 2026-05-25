#!/usr/bin/env node
/**
 * Safety Guard — PreToolUse Hook
 *
 * run_in_terminal / execute_command 호출 전에 실행.
 * 파괴적 명령어 패턴을 감지하면 경고를 표시하고 사용자 확인을 요청한다.
 *
 * 환경변수 (fallback):
 *   TOOL_NAME    호출된 도구 이름
 *   TOOL_INPUT   도구 입력 (JSON 문자열)
 */

'use strict';
const { getDestructivePatterns } = require('./shared-utils');
let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

(async () => {
  // stdin 읽기 (PreToolUse hook data)
  let stdinData = null;
  try {
    if (!process.stdin.isTTY) {
      const chunks = [];
      let totalBytes = 0;
      const MAX_STDIN_BYTES = 64 * 1024;
      for await (const chunk of process.stdin) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_STDIN_BYTES) { stdinData = null; break; }
        chunks.push(chunk);
      }
      if (chunks.length > 0) stdinData = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
    }
  } catch (_) {}

  // tool_name + tool_input: stdin 우선, env var fallback
  const toolName  = (stdinData?.tool_name  || process.env.TOOL_NAME  || '').trim();
  const toolInput = process.env.TOOL_INPUT || '{}';  // env var fallback (string)
  const rawTool   = stdinData?.tool_input;            // stdin에서 온 object

  // command 추출
  let command = '';
  try {
    const inp = (rawTool !== undefined && rawTool !== null)
      ? (typeof rawTool === 'object' ? rawTool : JSON.parse(rawTool))
      : JSON.parse(toolInput);
    const cmdStr  = inp.command || inp.cmd || '';
    const argsStr = Array.isArray(inp.args) ? inp.args.map(String).join(' ')
                  : (typeof inp.args === 'string' ? inp.args : '');
    command = cmdStr || argsStr;
  } catch { command = toolInput; }

  // ── 파괴적 명령 패턴 (meta/guards.json SSOT에서 로드) ────────────
  // force-with-lease는 원격 브랜치 보호 안전 메커니즘 — guards.json 패턴에서 제외됨.
  const DESTRUCTIVE_PATTERNS = getDestructivePatterns('js');
  const matched = DESTRUCTIVE_PATTERNS.filter(p => p.re.test(command));

  if (matched.length === 0) {
    const preview = command.length > 80 ? command.slice(0, 80) + '…' : command;
    tryAudit({ event: 'safety_guard', decision: 'allow', tool: toolName, commandPreview: preview.slice(0, 80) });
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

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
  process.stdout.write(JSON.stringify({ continue: false, decision: 'ask', reason: warning }));
  process.exit(0);
})();
