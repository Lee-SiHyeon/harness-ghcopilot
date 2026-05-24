'use strict';

const fs = require('fs');
const { GATE_PATH, EVIDENCE_PATH } = require('./paths.js');

const DEFAULT_GATE = {
  requiredSince: new Date().toISOString(),
  lockedBy: null,
  reason: '',
};

function readJson(filePath, defaultVal) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return Object.assign({}, defaultVal);
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getGateState() {
  return readJson(GATE_PATH, DEFAULT_GATE);
}

function setGateState(partial) {
  const state = getGateState();
  Object.assign(state, partial);
  writeJson(GATE_PATH, state);
  return state;
}

function recordEvidence(evidence) {
  const data = Object.assign({ ts: new Date().toISOString() }, evidence);
  writeJson(EVIDENCE_PATH, data);
  return data;
}

function getEvidence() {
  return readJson(EVIDENCE_PATH, { ts: null, status: null });
}

function isEvidenceValid() {
  const evidence = getEvidence();
  const passValue = evidence.status || evidence.result; // fallback for result field
  if (passValue !== 'PASS') return false;
  const gate = getGateState();
  if (!gate.requiredSince || !evidence.ts) return false;
  return new Date(evidence.ts) >= new Date(gate.requiredSince);
}

module.exports = { getGateState, setGateState, recordEvidence, getEvidence, isEvidenceValid };
