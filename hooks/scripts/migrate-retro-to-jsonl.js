#!/usr/bin/env node
/**
 * migrate-retro-to-jsonl.js
 * retrospective-history.md → retro.jsonl + retro-patterns.json 변환
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const LOGS_DIR       = path.resolve(__dirname, '../../logs');
const HISTORY_PATH   = path.join(LOGS_DIR, 'retrospective-history.md');
const JSONL_PATH     = path.join(LOGS_DIR, 'retro.jsonl');
const PATTERNS_PATH  = path.join(LOGS_DIR, 'retro-patterns.json');

// ─── 파싱 헬퍼 ─────────────────────────────────────────────────────
function parseSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    // ## 2026-05-24 — 제목 (type: pipeline) 형식 매칭
    const headerMatch = line.match(/^## (\d{4}-\d{2}-\d{2}) — (.+?)\s*\((.+?)\)\s*$/);
    if (headerMatch) {
      if (current) sections.push(current);
      const [, date, title, meta] = headerMatch;
      // meta: "fix: Planner→..." 또는 "fix+feat: ..."
      const colonIdx = meta.indexOf(':');
      const type     = colonIdx !== -1 ? meta.slice(0, colonIdx).trim() : meta.trim();
      const pipeline = colonIdx !== -1 ? meta.slice(colonIdx + 1).trim() : '';
      current = { date, title, type, pipeline, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function extractField(lines, label) {
  for (const line of lines) {
    // 테이블 행: | 실행 | ... |
    const tableMatch = line.match(new RegExp(`^\\|\\s*${label}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`));
    if (tableMatch) return tableMatch[1].trim();
  }
  return '';
}

function extractBold(lines, label) {
  for (const line of lines) {
    const m = line.match(new RegExp(`^\\*\\*${label}\\*\\*:\\s*(.+)`));
    if (m) return m[1].trim();
  }
  return '';
}

function parsePatterns(content) {
  // ## 반복 패턴 섹션 찾기
  const lines = content.split('\n');
  const start = lines.findIndex(l => l.startsWith('## 반복 패턴'));
  if (start === -1) return [];

  const results = [];
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const slice = end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, end);

  for (const line of slice) {
    // - **패턴명**: N회 / 마지막: DATE / 개선: TEXT
    const m = line.match(/^-\s+\*\*(.+?)\*\*:\s+(.+)/);
    if (!m) continue;
    const name = m[1].trim();
    const rest = m[2].trim();

    // count 파싱
    const countM = rest.match(/(\d+)회/);
    const count  = countM ? parseInt(countM[1], 10) : 1;

    // last 파싱
    const lastM = rest.match(/마지막:\s*(\S+)/);
    const last  = lastM ? lastM[1].replace(/\s*\/.*/, '').trim() : '';

    // fix 파싱
    const fixM = rest.match(/개선:\s*(.+)/);
    const fix  = fixM ? fixM[1].trim() : '';

    results.push({ name, count, last, fix });
  }
  return results;
}

// ─── 메인 ──────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.error(`파일 없음: ${HISTORY_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(HISTORY_PATH, 'utf8');
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  // 기존 JSONL 레코드 로드 (dedup 용)
  const existingKeys = new Set();
  if (fs.existsSync(JSONL_PATH)) {
    const existing = fs.readFileSync(JSONL_PATH, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of existing) {
      try {
        const r = JSON.parse(line);
        if (r.date && r.title) existingKeys.add(`${r.date}|${r.title}`);
      } catch { /* skip */ }
    }
  }

  // 섹션 파싱 → JSONL append
  const sections = parseSections(content);
  let added = 0;

  const fd = fs.openSync(JSONL_PATH, 'a');
  for (const s of sections) {
    const key = `${s.date}|${s.title}`;
    if (existingKeys.has(key)) continue;

    const record = {
      v:               1,
      date:            s.date,
      title:           s.title,
      type:            s.type,
      pipeline:        s.pipeline,
      executed:        extractField(s.lines, '실행'),
      skipped:         extractField(s.lines, '건너뜀'),
      repeatIssue:     extractField(s.lines, '반복 이슈'),
      selfCritique:    extractBold(s.lines, '자기비평'),
      nextImprovement: extractBold(s.lines, '다음 번 개선'),
      ts:              new Date().toISOString(),
      sessionId:       '',
    };

    fs.writeSync(fd, JSON.stringify(record) + '\n');
    existingKeys.add(key);
    added++;
  }
  fs.closeSync(fd);

  console.log(`retro.jsonl: ${added}개 레코드 추가 (기존 중복 제외)`);

  // 반복 패턴 → retro-patterns.json
  const patterns = parsePatterns(content);
  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2), 'utf8');
  console.log(`retro-patterns.json: ${patterns.length}개 패턴 저장`);
}

main();
