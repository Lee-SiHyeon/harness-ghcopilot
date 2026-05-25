#!/usr/bin/env node
/**
 * model-guard.js — PreToolUse runSubagent 모델 임의 강제 방지 가드
 *
 * 규칙: "사용자가 특정 모델을 명시적으로 요청하지 않으면 model 파라미터를 지정하지 않는다."
 *
 * 동작:
 *   - runSubagent 호출에 model 파라미터가 있으면:
 *     → current-intent.json에 userRequestedModel=true가 없으면 ask(차단)
 *     → userRequestedModel=true이면 허용
 */

'use strict';

const path = require('path');
const fs   = require('fs');

let audit = null;
try { audit = require('./audit-logger'); } catch (_) {}
function tryAudit(obj) { if (!audit) return; try { audit.appendAudit(obj); } catch (_) {} }

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

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

try {
  const agentName = (stdinData?.agent_name || process.env.AGENT_NAME || 'unknown').trim();
  let input = stdinData?.tool_input || {};
  if (!input || typeof input !== 'object') {
    try { input = JSON.parse(process.env.TOOL_INPUT || '{}'); } catch(_) { input = {}; }
  }

  // model 파라미터 없으면 패스
  if (!input.model) { out({ continue: true }); process.exit(0); }

  // 에이전트 파일의 선언된 model 목록 조회
  function loadAgentModelList(name) {
    if (!name || name === 'unknown') return [];
    try {
      const agentsDir = path.join(process.cwd(), '.github', 'agents');
      // agentName과 일치하는 .agent.md 파일 탐색
      const files = fs.readdirSync(agentsDir);
      for (const f of files) {
        if (!f.endsWith('.agent.md')) continue;
        const content = fs.readFileSync(path.join(agentsDir, f), 'utf8');
        // name: 필드 확인 (RegExp 인젝션 방지: 특수문자 이스케이프)
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`^name:\\s*${escapedName}\\s*$`, 'm').test(content)) continue;
        // model: [...] 파싱
        const modelMatch = content.match(/^model:\s*\[([^\]]+)\]/m);
        if (!modelMatch) return [];
        return modelMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
      }
    } catch { return []; }
    return [];
  }

  // 에이전트 파일에 선언된 모델이면 허용 (정상 fallback)
  const agentModels = loadAgentModelList(agentName);
  if (agentModels.length > 0 && agentModels.includes(input.model)) {
    out({ continue: true });
    process.exit(0);
  }

  // current-intent.json에서 사용자가 모델을 명시 요청했는지 확인
  function loadCurrentIntent() {
    try {
      const intentFile = path.join(process.cwd(), '.github', 'logs', 'current-intent.json');
      const data = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
      // 1시간 이상 된 stale 데이터는 무시
      if (Date.now() - new Date(data.ts || 0).getTime() > 3600000) return null;
      return data;
    } catch { return null; }
  }

  const intentData = loadCurrentIntent();
  if (intentData && intentData.userRequestedModel === true) {
    // 사용자가 명시 요청한 모델 → 허용
    out({ continue: true });
    process.exit(0);
  }

  // 사용자 요청 없는 model 강제 → 차단
  tryAudit({ event: 'model_guard', decision: 'ask', agent: agentName, model: input.model });
  out({
    continue: false,
    decision: 'ask',
    reason: [
      `🚫 [model-guard] runSubagent에 model="${input.model}"이 명시됐지만 사용자가 특정 모델을 요청하지 않았습니다.`,
      '',
      '규칙: "사용자가 특정 모델을 명시적으로 요청하지 않으면 model 파라미터를 지정하지 않는다."',
      '',
      '해결:',
      '  1. model 파라미터를 제거하고 재호출 (에이전트 파일 폴백 허용)',
      '  2. cost tier 오류 시 에이전트 파일 model 목록의 다음 폴백 모델로 재호출',
    ].join('\n'),
  });

} catch (_) {
  // 에러 시 통과 (훅이 파이프라인을 막아선 안 됨)
  out({ continue: true });
}
})();
process.exit(0);
