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

try {
  const agentName = (process.env.AGENT_NAME || 'unknown').trim();
  const rawInput  = process.env.TOOL_INPUT  || '{}';

  let input = {};
  try { input = JSON.parse(rawInput); } catch (_) {}

  // model 파라미터 없으면 패스
  if (!input.model) { out({ continue: true }); process.exit(0); }

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
process.exit(0);
