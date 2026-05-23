#!/usr/bin/env node
/**
 * file-guard.js — PreToolUse 파일/훅 자기수정 보호 가드
 *
 * 보호 대상:
 *   - .github/hooks/ 하위 전체 → ask
 *   - .github/agents/maestro.agent.md → Maestro 자기수정 전용 보호
 *   - .env, .env.*, *.pem, *.key, *.cert 등 민감 파일 → ask
 *   - lock 파일 삭제/이동/이름변경 → ask, 수정은 continue + 경고
 *   - 일반 파일 삭제/이동/이름변경 → continue + 로그
 *
 * 환경변수:
 *   TOOL_NAME    실행될 도구 이름
 *   TOOL_INPUT   도구 입력 (JSON 문자열)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

try {
  const toolName     = (process.env.TOOL_NAME  || '').trim();
  const agentName    = (process.env.AGENT_NAME || 'unknown').trim();
  const subagentName = (process.env.SUBAGENT_NAME || '').trim();
  const rawInput  = process.env.TOOL_INPUT  || '{}';

  let input = {};
  try { input = JSON.parse(rawInput); } catch (_) {}

  // ── 경로 후보 키 ────────────────────────────────────────────────
  const PATH_KEYS = [
    'path', 'file_path', 'filePath', 'source', 'destination',
    'oldPath', 'newPath', 'from', 'to',
  ];

  const PATCH_TEXT_KEYS = ['input', 'patch', 'diff'];

  const cwd = process.cwd();

  function normalizePath(p) {
    if (!p || typeof p !== 'string') return null;
    // 절대화 후 / 통일
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    return abs.replace(/\\/g, '/');
  }

  // workspace 밖 여부 확인
  const cwdNorm = cwd.replace(/\\/g, '/');
  function isOutsideWorkspace(normPath) {
    return !normPath.startsWith(cwdNorm + '/') && normPath !== cwdNorm;
  }

  // 보호 패턴 ─────────────────────────────────────────────────────
  function isHooksPath(p) {
    const rel = p.slice(cwdNorm.length + 1);
    return rel.startsWith('.github/hooks/');
  }

  function isMaestroAgentPath(p) {
    const rel = p.slice(cwdNorm.length + 1);
    return rel === '.github/agents/maestro.agent.md';
  }

  function isMaestroAgent(name) {
    return String(name || '').toLowerCase() === 'maestro';
  }

  function hasAgentIdentityConflict() {
    return !!subagentName && !!agentName && subagentName !== agentName;
  }

  function isSensitivePath(p) {
    const base = path.posix.basename(p);
    // .env, .env.xxx
    if (base === '.env' || base.startsWith('.env.')) return true;
    // 인증서/키/시크릿 파일
    if (/\.(pem|key|cert|p12|pfx)$/.test(base)) return true;
    if (/credentials|\.secret/.test(base)) return true;
    return false;
  }

  const LOCK_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
  function isLockFile(p) {
    return LOCK_FILES.has(path.posix.basename(p));
  }

  // 파괴적 조작 여부
  const DESTRUCTIVE_OPS = new Set(['delete_file', 'rename_file', 'move_file']);
  const isDestructive = DESTRUCTIVE_OPS.has(toolName);

  // 경로 수집
  const paths = [];
  for (const key of PATH_KEYS) {
    const val = input[key];
    if (!val) continue;
    if (Array.isArray(val)) {
      for (const v of val) { const n = normalizePath(v); if (n) paths.push(n); }
    } else {
      const n = normalizePath(val);
      if (n) paths.push(n);
    }
  }

  if (toolName === 'apply_patch') {
    for (const key of PATCH_TEXT_KEYS) {
      const patchText = input[key];
      if (!patchText || typeof patchText !== 'string') continue;
      const re = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gm;
      let match;
      while ((match = re.exec(patchText)) !== null) {
        const filePath = match[1].trim();
        const n = normalizePath(filePath);
        if (n) paths.push(n);
      }
    }
  }

  // apply_patch는 경로 파싱 실패 시 어떤 파일이 바뀌는지 알 수 없으므로 차단한다.
  if (paths.length === 0 && toolName === 'apply_patch') {
    tryAudit({ event: 'file_guard', decision: 'deny', tool: toolName, agent: agentName, reason: 'apply_patch_paths_unparsed' });
    out({
      continue: false,
      decision: 'deny',
      reason: '🚫 apply_patch 경로를 파싱할 수 없어 파일 조작을 차단했습니다.',
    });
    process.exit(0);
  }

  // 경로가 없으면 그냥 통과
  if (paths.length === 0) { out({ continue: true }); process.exit(0); }

  // ── 경로별 판단 (모든 경로 검사 후 최종 판정 1회) ───────────────
  const denyItems = [];   // → block + deny (Maestro 파일 비인가 수정)
  const askItems  = [];   // → block + ask
  const warnItems = [];   // → continue + warning (lock 수정)
  const logItems  = [];   // → continue + log (일반 파괴적 조작)

  for (const p of paths) {
    const relPath = p.startsWith(cwdNorm + '/') ? p.slice(cwdNorm.length + 1) : p;

    if (isOutsideWorkspace(p)) {
      askItems.push(`⚠️ 워크스페이스 외부: ${relPath}`);
      continue;
    }
    if (isMaestroAgentPath(p)) {
      if (isMaestroAgent(agentName) && !hasAgentIdentityConflict()) {
        askItems.push(`🎼 Maestro 자기수정 확인 필요: ${relPath}`);
      } else {
        const identity = subagentName ? `agent=${agentName}, subagent=${subagentName}` : `agent=${agentName}`;
        denyItems.push(`🎼 Maestro 파일은 Maestro 자신만 수정 가능: ${relPath} (${identity})`);
      }
      continue;
    }
    if (isHooksPath(p)) {
      askItems.push(`🛡️ 훅 자기수정 보호 (.github/hooks/): ${relPath}`);
      continue;
    }
    if (isSensitivePath(p)) {
      askItems.push(`🔒 민감 파일: ${path.posix.basename(p)}`);
      continue;
    }
    if (isLockFile(p)) {
      if (isDestructive) {
        askItems.push(`📦 Lock 파일 삭제/이동: ${path.posix.basename(p)}`);
      } else {
        warnItems.push(`⚠️ [file-guard] lock 파일 수정: \`${path.posix.basename(p)}\` — 의도한 변경인지 확인하세요.`);
      }
      continue;
    }
    if (isDestructive) {
      logItems.push({ ts: new Date().toISOString(), tool: toolName, path: p, rel: relPath });
    }
  }

  // ── 최종 판정 (우선순위: ask > warn/log > continue) ────────────
  if (denyItems.length > 0) {
    const MAX_DISPLAY = 5;
    const display = denyItems.slice(0, MAX_DISPLAY);
    const extra   = denyItems.length > MAX_DISPLAY ? `\n  … 외 ${denyItems.length - MAX_DISPLAY}개` : '';
    tryAudit({ event: 'file_guard', decision: 'deny', tool: toolName, agent: agentName, subagent: subagentName || null, items: denyItems.slice(0, 5) });
    out({
      continue: false,
      decision: 'deny',
      reason: [
        `🚫 Maestro 자기수정 보호 — 도구: ${toolName}`,
        display.map(r => `  - ${r}`).join('\n') + extra,
        'Maestro 파일은 사용자의 명시 요청이 있을 때 Maestro 자신만 수정할 수 있습니다.',
      ].join('\n'),
    });
  } else if (askItems.length > 0) {
    const MAX_DISPLAY = 5;
    const display = askItems.slice(0, MAX_DISPLAY);
    const extra   = askItems.length > MAX_DISPLAY ? `\n  … 외 ${askItems.length - MAX_DISPLAY}개` : '';
    tryAudit({ event: 'file_guard', decision: 'ask', tool: toolName, agent: agentName, subagent: subagentName || null, items: askItems.slice(0, 5) });
    out({
      continue: false,
      decision: 'ask',
      reason: [
        `🚫 보호된 파일 조작 감지 — 도구: ${toolName}`,
        display.map(r => `  - ${r}`).join('\n') + extra,
        '계속 진행하려면 명시적으로 허용해 주세요.',
      ].join('\n'),
    });
  } else if (warnItems.length > 0 || logItems.length > 0) {
    if (logItems.length > 0) {
      const logsDir = path.resolve(cwd, '.github', 'logs');
      try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}
      for (const entry of logItems) {
        try {
          fs.appendFileSync(
            path.join(logsDir, 'file-ops.jsonl'),
            JSON.stringify({ ts: entry.ts, tool: entry.tool, path: entry.path }) + '\n',
            'utf8'
          );
        } catch (_) {}
      }
    }
    tryAudit({ event: 'file_guard', decision: 'continue_warn', tool: toolName, warns: warnItems.length, logs: logItems.length });
    const msgs = [
      ...warnItems,
      ...logItems.map(e => `🗑️ [file-guard] 파일 조작: \`${toolName}\` → \`${e.rel}\``),
    ];
    out({
      continue: true,
      hookSpecificOutput: msgs.slice(0, 5).join('\n'),
    });
  } else {
    tryAudit({ event: 'file_guard', decision: 'allow', tool: toolName });
    out({ continue: true });
  }
} catch (_) {
  // 파일 보호 가드는 실패 시 안전하게 deny한다.
  tryAudit({ event: 'file_guard', decision: 'deny', tool: process.env.TOOL_NAME || 'unknown', reason: 'internal_error' });
  out({
    continue: false,
    decision: 'deny',
    reason: '🚫 file-guard 내부 오류로 파일 조작을 차단했습니다. 훅 로그를 확인한 뒤 다시 시도하세요.',
  });
}
