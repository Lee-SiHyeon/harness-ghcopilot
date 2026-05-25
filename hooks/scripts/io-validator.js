#!/usr/bin/env node
/**
 * io-validator.js — 에이전트 입출력 계약 검증 공통 라이브러리
 *
 * 사용:
 *   const { loadContract, validateInputs, validateOutputs } = require('./io-validator');
 *
 * context 구조:
 *   { agentName, sessionId, prompt, startTs, flowLines, fileChangeLines }
 *
 * 반환:
 *   { ok: bool, missing: string[], warnings: string[] }
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CONTRACTS_PATH = path.resolve(__dirname, '..', '..', 'meta', 'agent-contracts.json');

/** agent-contracts.json 전체 로드 */
function loadContracts() {
  try { return JSON.parse(fs.readFileSync(CONTRACTS_PATH, 'utf8')); }
  catch (_) { return null; }
}

/** 에이전트별 계약 로드 (case-insensitive) */
function loadContract(agentName) {
  const contracts = loadContracts();
  if (!contracts) return null;
  const key = Object.keys(contracts.agents || {})
    .find(k => k.toLowerCase() === (agentName || '').toLowerCase());
  return key ? contracts.agents[key] : null;
}

/** 파일 경로가 패턴 배열에 매칭되는지 확인 (simple suffix/prefix match, minimatch 불필요) */
function matchesPattern(filePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  let normalized = filePath.replace(/\\/g, '/');
  // 절대경로인 경우 cwd 기준으로 상대경로로 변환
  const cwd = process.cwd().replace(/\\/g, '/');
  if (normalized.startsWith(cwd + '/')) {
    normalized = normalized.slice(cwd.length + 1);
  } else if (normalized.startsWith(cwd)) {
    normalized = normalized.slice(cwd.length);
  }
  return patterns.some(pat => {
    const p = pat.replace(/\\/g, '/');
    if (!p) return false;
    if (p.startsWith('**')) {
      const suffix = p.replace(/^\*\*\//, '');
      const ext = suffix.startsWith('*') ? suffix.slice(1) : null;
      return ext ? normalized.endsWith(ext) : normalized.includes(suffix);
    }
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -3);
      return normalized.startsWith(prefix + '/') || normalized === prefix;
    }
    if (p.includes('*')) {
      const ext = p.slice(p.lastIndexOf('*') + 1);
      return ext ? normalized.endsWith(ext) : false;
    }
    return normalized.endsWith(p) || normalized.includes(p.replace(/\/$/, ''));
  });
}

/**
 * SubagentStart 시 inputs 검증
 * @param {string} agentName
 * @param {{ prompt:string, sessionId:string, flowLines:object[] }} context
 * @returns {{ ok:boolean, missing:string[], warnings:string[] }}
 */
function validateInputs(agentName, context) {
  const contract = loadContract(agentName);
  if (!contract) return { ok: true, missing: [], warnings: ['no_contract'] };

  const missing = [];
  const warnings = [];
  const inputs = contract.inputs || {};
  const prompt = (context.prompt || '').toLowerCase();

  // [Check 1] promptKeywords — soft only (경고만, missing 아님)
  const keywords = inputs.promptKeywords || [];
  if (keywords.length > 0 && !keywords.some(k => prompt.includes(k.toLowerCase()))) {
    warnings.push('prompt_keywords_missing: ' + keywords.join('|'));
  }

  // [Check 2] requiredPredecessor (hard) — JSONL에서 이전 실행 확인
  const reqPred = inputs.requiredPredecessor;
  if (reqPred) {
    const flowLines = context.flowLines || [];
    const found = flowLines.some(l =>
      l.event === 'SubagentStop' &&
      (l.agentName || '').toLowerCase() === reqPred.toLowerCase() &&
      (!context.sessionId || l.sessionId === context.sessionId)
    );
    if (!found) missing.push('predecessor_not_completed: ' + reqPred);
  }

  // [Check 3] requiredPredecessorSoft — warnings only
  const reqPredSoft = inputs.requiredPredecessorSoft || [];
  for (const pred of reqPredSoft) {
    const flowLines = context.flowLines || [];
    const found = flowLines.some(l =>
      l.event === 'SubagentStop' &&
      (l.agentName || '').toLowerCase() === pred.toLowerCase() &&
      (!context.sessionId || l.sessionId === context.sessionId)
    );
    if (!found) warnings.push('predecessor_not_completed_soft: ' + pred);
  }

  // [Check 4] requiredFile (hard)
  const reqFile = inputs.requiredFile;
  if (reqFile) {
    const absPath = path.resolve(process.cwd(), reqFile);
    if (!fs.existsSync(absPath)) {
      missing.push('required_file_missing: ' + reqFile);
    } else if (inputs.requiredFileField) {
      try {
        const data = JSON.parse(fs.readFileSync(absPath, 'utf8'));
        const actual = data[inputs.requiredFileField];
        if (inputs.requiredFileValue !== undefined && actual !== inputs.requiredFileValue) {
          missing.push('required_file_value_mismatch: ' + reqFile + ' ' + inputs.requiredFileField + '=' + actual + ' expected=' + inputs.requiredFileValue);
        }
      } catch (_) {
        warnings.push('required_file_parse_error: ' + reqFile);
      }
    }
  }

  return { ok: missing.length === 0, missing, warnings };
}

/**
 * SubagentStop 시 outputs 검증
 * @param {string} agentName
 * @param {{ sessionId:string, startTs:string|null, flowLines:object[], fileChangeLines:object[] }} context
 * @returns {{ ok:boolean, missing:string[], warnings:string[] }}
 */
function validateOutputs(agentName, context) {
  const contract = loadContract(agentName);
  if (!contract) return { ok: true, missing: [], warnings: ['no_contract'] };

  const missing = [];
  const warnings = [];
  const outputs = contract.outputs || {};

  // [Check 1] filesModified (hard when true)
  if (outputs.filesModified === true) {
    const fileChangeLines = context.fileChangeLines || [];
    const startTs = context.startTs ? new Date(context.startTs).getTime() : 0;
    const excludePats = outputs.excludePatterns || [];
    const includePats = outputs.fileModifiedPatterns || [];

    const matchedFiles = fileChangeLines.filter(l => {
      if (context.sessionId && l.session && l.session !== context.sessionId) return false;
      if (startTs && l.ts && new Date(l.ts).getTime() < startTs) return false;
      const paths = Array.isArray(l.paths) ? l.paths : (l.path ? [l.path] : []);
      return paths.filter(Boolean).some(p =>
        (includePats.length === 0 || matchesPattern(p, includePats)) &&
        !matchesPattern(p, excludePats)
      );
    });

    const min = outputs.minFilesModified || 1;
    if (matchedFiles.length < min) {
      missing.push('files_not_modified: expected >=' + min + ' got ' + matchedFiles.length);
    }
  }

  // [Check 2] evidenceFile (hard when defined)
  const evidenceFile = outputs.evidenceFile;
  if (evidenceFile) {
    const absPath = path.resolve(process.cwd(), evidenceFile);
    if (!fs.existsSync(absPath)) {
      missing.push('evidence_file_missing: ' + evidenceFile);
    } else if (outputs.evidenceField) {
      try {
        const data = JSON.parse(fs.readFileSync(absPath, 'utf8'));
        const actual = data[outputs.evidenceField];
        if (outputs.evidenceExpectedValue !== undefined && actual !== outputs.evidenceExpectedValue) {
          missing.push('evidence_value_mismatch: ' + outputs.evidenceField + '=' + actual + ' expected=' + outputs.evidenceExpectedValue);
        }
      } catch (_) {
        warnings.push('evidence_file_parse_error: ' + evidenceFile);
      }
    }
  }

  // [Check 3] subagentFlowLogged (soft)
  if (outputs.subagentFlowLogged) {
    const flowLines = context.flowLines || [];
    const found = flowLines.some(l =>
      l.event === 'SubagentStop' &&
      (l.agentName || '').toLowerCase() === agentName.toLowerCase() &&
      (!context.sessionId || l.sessionId === context.sessionId)
    );
    if (!found) warnings.push('subagent_flow_not_logged: ' + agentName);
  }

  return { ok: missing.length === 0, missing, warnings };
}

module.exports = { loadContract, loadContracts, validateInputs, validateOutputs, matchesPattern };