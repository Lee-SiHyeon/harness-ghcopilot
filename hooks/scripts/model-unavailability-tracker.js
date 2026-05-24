#!/usr/bin/env node
/**
 * model-unavailability-tracker.js — PostToolUse cost tier 초과 모델 자동 추적
 *
 * runSubagent 호출이 cost tier 오류로 실패하면
 * .github/logs/cost-tier-exceeded.json 에 해당 모델을 기록한다.
 * maestro-router.js가 이 파일을 읽어 Maestro 컨텍스트에 주입한다.
 *
 * 환경변수:
 *   TOOL_NAME    실행된 도구 이름
 *   TOOL_RESULT  도구 결과 (에러 메시지 포함)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const toolName  = (process.env.TOOL_NAME  || '').trim();
const toolResult = process.env.TOOL_RESULT || '';
const toolError  = process.env.TOOL_ERROR  || '';

// runSubagent 아닌 경우 패스
if (toolName !== 'runSubagent') process.exit(0);

const combined = toolResult + '\n' + toolError;

// cost tier 오류 감지: "Requested model 'X' exceeds the current model's cost tier"
const match = combined.match(/Requested model '([^']+)' exceeds(?:\s+the)?\s+current model'?s? cost tier/i);
if (!match) process.exit(0);

const exceededModel = match[1];

try {
  const logsDir = path.resolve(process.cwd(), '.github', 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}

  const file = path.join(logsDir, 'cost-tier-exceeded.json');
  let data = { models: [], updatedAt: null };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (!Array.isArray(data.models)) data.models = [];

  // TTL: 24h 초과 시 stale 항목 초기화 (플랜 업그레이드·일시 오류 후 자동 복구)
  const TTL_MS = 24 * 60 * 60 * 1000;
  if (data.updatedAt && Date.now() - new Date(data.updatedAt).getTime() > TTL_MS) {
    data.models = [];
  }

  if (!data.models.includes(exceededModel)) {
    data.models.push(exceededModel);
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
} catch (_) {}

process.exit(0);
