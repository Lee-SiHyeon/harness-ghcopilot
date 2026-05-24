'use strict';

const path = require('path');
const fs   = require('fs');

const LOGS_DIR = path.resolve(__dirname, '../../logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

const TODOS_PATH    = path.join(LOGS_DIR, 'current-todos.json');
const DRAFT_PATH    = path.join(LOGS_DIR, 'retrospective-draft.json');
const FLOW_PATH     = path.join(LOGS_DIR, 'subagent-flow.jsonl');
const STARTS_PATH   = path.join(LOGS_DIR, 'last-subagent-start.json');
const EVIDENCE_PATH = path.join(LOGS_DIR, 'test-evidence.json');
const GATE_PATH     = path.join(LOGS_DIR, 'test-gate-state.json');
const RETRO_PATH    = path.join(LOGS_DIR, 'retro.jsonl');
const PATTERNS_PATH = path.join(LOGS_DIR, 'retro-patterns.json');

module.exports = {
  LOGS_DIR,
  TODOS_PATH,
  DRAFT_PATH,
  FLOW_PATH,
  STARTS_PATH,
  EVIDENCE_PATH,
  GATE_PATH,
  RETRO_PATH,
  PATTERNS_PATH,
};
