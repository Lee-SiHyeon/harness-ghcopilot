'use strict';

const fs = require('fs');
const { DRAFT_PATH } = require('./paths.js');

const DEFAULT_DRAFT = {
  sessionId: '',
  ts: new Date().toISOString(),
  terminalAgent: '',
  intent: '',
  complexity: 0,
  plannedPipeline: [],
  executedAgents: [],
  skippedAgents: [],
  durationMs: null,
  actionItems: [],
};

function readDraft() {
  try {
    return JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
  } catch (_) {
    return Object.assign({}, DEFAULT_DRAFT, { ts: new Date().toISOString() });
  }
}

function writeDraft(data) {
  fs.writeFileSync(DRAFT_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getDraft() {
  return readDraft();
}

function getActionItems() {
  return readDraft().actionItems || [];
}

function appendActionItems(items) {
  const draft = readDraft();
  const existing = new Set((draft.actionItems || []).map((i) => i.message));
  for (const item of items) {
    if (!existing.has(item.message)) {
      draft.actionItems.push(item);
      existing.add(item.message);
    }
  }
  draft.ts = new Date().toISOString();
  writeDraft(draft);
  return draft.actionItems;
}

function consumeActionItems() {
  const draft = readDraft();
  const current = draft.actionItems || [];
  draft.actionItems = [];
  draft.ts = new Date().toISOString();
  writeDraft(draft);
  return current;
}

function updateDraft(partial) {
  const draft = readDraft();
  Object.assign(draft, partial, { ts: new Date().toISOString() });
  writeDraft(draft);
  return draft;
}

module.exports = { getDraft, getActionItems, appendActionItems, consumeActionItems, updateDraft };
