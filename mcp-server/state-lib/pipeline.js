'use strict';

const fs    = require('fs');
const crypto = require('crypto');
const { STARTS_PATH, FLOW_PATH } = require('./paths.js');

function readStarts() {
  try {
    return JSON.parse(fs.readFileSync(STARTS_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeStarts(data) {
  fs.writeFileSync(STARTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function recordStart(agentName, sessionId) {
  const starts = readStarts();
  const correlationId = crypto.randomUUID();
  const entry = {
    startTs: new Date().toISOString(),
    seq: Date.now(),
    correlationId,
    sessionId: sessionId || null,
    agentName,
  };
  if (!Array.isArray(starts[agentName])) starts[agentName] = [];
  starts[agentName].push(entry);
  starts.__last__ = entry;
  writeStarts(starts);
  return entry;
}

function recordStop(agentName, sessionId) {
  const starts = readStarts();
  const entries = starts[agentName];
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // Find matching entry by sessionId (most recent if no match)
  let idx = -1;
  if (sessionId) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].sessionId === sessionId) { idx = i; break; }
    }
  }
  if (idx === -1) idx = entries.length - 1;

  const entry = entries.splice(idx, 1)[0];
  writeStarts(starts);

  const stopTs = new Date().toISOString();
  const durationMs = Date.now() - new Date(entry.startTs).getTime();
  const flowEntry = {
    ts: stopTs,
    agentName,
    sessionId: entry.sessionId,
    correlationId: entry.correlationId,
    startTs: entry.startTs,
    durationMs,
  };
  fs.appendFileSync(FLOW_PATH, JSON.stringify(flowEntry) + '\n', 'utf8');
  return flowEntry;
}

function queryFlow({ agentName, limit = 20 } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(FLOW_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {}

  if (agentName) lines = lines.filter((e) => e.agentName === agentName);
  return lines.slice(-limit).reverse();
}

module.exports = { recordStart, recordStop, queryFlow };
