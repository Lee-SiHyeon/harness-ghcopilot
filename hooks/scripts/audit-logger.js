#!/usr/bin/env node
/**
 * audit-logger.js — Shared hook audit logging module
 *
 * Node 내장 모듈만 사용. fail-open.
 * 모든 함수는 throw 하지 않는다.
 *
 * Exports:
 *   SENSITIVE_RE            — redaction 정규식 (replace 용)
 *   normalizePath(p)        — 경로 정규화
 *   summarize(raw, maxLen)  — redact + 길이 제한 요약
 *   nextSeq()               — 단조증가 시퀀스 번호
 *   appendLine(file, obj)   — low-level JSONL append (rotation 포함)
 *   appendAudit(obj)        — .github/logs/hook-audit.jsonl 기록
 *   appendSubagentFlow(obj) — .github/logs/subagent-flow.jsonl 기록
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CWD      = process.cwd();
const LOGS_DIR = path.resolve(CWD, '.github', 'logs');
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (_) {}

const AUDIT_FILE    = path.join(LOGS_DIR, 'hook-audit.jsonl');
const SUBAGENT_FILE = path.join(LOGS_DIR, 'subagent-flow.jsonl');
const SEQ_FILE      = path.join(LOGS_DIR, 'audit-seq.json');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

// ── Sensitive redaction pattern ─────────────────────────────────
// Covers: Authorization header, Bearer token, key=value secrets,
//         PEM blocks, URL embedded credentials.
// 사용: str.replace(new RegExp(SENSITIVE_RE.source, SENSITIVE_RE.flags), '[REDACTED]')
//       또는 redact(str) 헬퍼 사용.
const SENSITIVE_RE = /(?:authorization\s*:[^\n\r]*|bearer\s+\S+|(?:token|api[_-]?key|apikey|password|secret|opencode_api_key)\s*[=:]\s*\S+|https?:\/\/[^:@\s]+:[^@\s]+@\S+|-----BEGIN\s[A-Z ]+-----[\s\S]*?-----END\s[A-Z ]+-----)/gi;

// ── normalizePath ─────────────────────────────────────────────────
function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  try {
    const abs = path.isAbsolute(p) ? p : path.resolve(CWD, p);
    return abs.replace(/\\/g, '/');
  } catch (_) { return null; }
}

// ── redact ────────────────────────────────────────────────────────
function redact(text) {
  if (!text || typeof text !== 'string') return text;
  // Create fresh regex each call to avoid stateful lastIndex issues
  const re = new RegExp(SENSITIVE_RE.source, SENSITIVE_RE.flags);
  return text.replace(re, '[REDACTED]');
}

// ── summarize ─────────────────────────────────────────────────────
function summarize(raw, maxLen) {
  const limit = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : 300;
  if (raw === null || raw === undefined) return null;
  try {
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const redacted = redact(str);
    return redacted.length > limit ? redacted.slice(0, limit) + '…' : redacted;
  } catch (_) { return null; }
}

// ── sequence counter (best-effort, non-blocking) ──────────────────
function nextSeq() {
  try {
    let seq = 0;
    try {
      const content = fs.readFileSync(SEQ_FILE, 'utf8');
      if (content.trim()) {
        const saved = JSON.parse(content);
        seq = (typeof saved.seq === 'number' ? saved.seq : 0) + 1;
      } else {
        seq = 1;
      }
    } catch (_) { seq = 1; }
    const data = JSON.stringify({ seq, ts: new Date().toISOString() });
    const tmp = SEQ_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, SEQ_FILE);
    } catch (_) {
      fs.writeFileSync(SEQ_FILE, data, 'utf8');
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return seq;
  } catch (_) {
    // fallback: timestamp-based unique value
    return Date.now();
  }
}

// ── best-effort JSONL rotation (>5 MB) ────────────────────────────
function rotateIfNeeded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size >= MAX_FILE_BYTES) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const rotated = filePath.replace(/\.jsonl$/, `.${ts}.jsonl`);
      try { fs.renameSync(filePath, rotated); } catch (_) {}
    }
  } catch (_) {}
}

// ── appendLine ────────────────────────────────────────────────────
function appendLine(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
  } catch (_) {}
}

// ── appendAudit ───────────────────────────────────────────────────
function appendAudit(obj) {
  try {
    const now = new Date().toISOString();
    const entry = {
      ...obj,
      ts:  obj.ts  || now,
      seq: obj.seq != null ? obj.seq : nextSeq(),
    };
    appendLine(AUDIT_FILE, entry);
  } catch (_) {}
}

// ── appendSubagentFlow ────────────────────────────────────────────
function appendSubagentFlow(obj) {
  try {
    const now = new Date().toISOString();
    const entry = {
      ...obj,
      ts:  obj.ts  || now,
      seq: obj.seq != null ? obj.seq : nextSeq(),
    };
    appendLine(SUBAGENT_FILE, entry);
  } catch (_) {}
}

module.exports = {
  SENSITIVE_RE,
  normalizePath,
  summarize,
  nextSeq,
  appendLine,
  appendAudit,
  appendSubagentFlow,
};
