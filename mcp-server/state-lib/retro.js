'use strict';

const fs = require('fs');
const { RETRO_PATH, PATTERNS_PATH } = require('./paths.js');

function appendRetro(entry) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry));
  fs.appendFileSync(RETRO_PATH, line + '\n', 'utf8');
  return entry;
}

function getRecentRetro(limit = 5) {
  let lines = [];
  try {
    lines = fs.readFileSync(RETRO_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {}
  return lines.slice(-limit).reverse();
}

function getPatterns() {
  try {
    return JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

module.exports = { appendRetro, getRecentRetro, getPatterns };
