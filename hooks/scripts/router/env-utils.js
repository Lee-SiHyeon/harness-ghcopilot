'use strict';

const fs   = require('fs');
const path = require('path');

// ── .env 파싱 (dotenv 패키지 없이) ─────────────────────────────────
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?([\w_]+)\s*=(.*)$/);
    if (m && !process.env[m[1]]) {
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        val = val.replace(/\s+#.*$/, '').trim();
      }
      process.env[m[1]] = val;
    }
  }
}

// allow-list 기반: 허용된 유니코드 범주만 통과 (Node.js ≥ 12 필요)
const ALLOWED_CHARS_RE = /[^\p{L}\p{N}\p{Z}\p{P}\p{S}\r\n]/gu;

// ── 프롬프트 인젝션 방지 sanitize ────────────────────────────
function sanitizeForPrompt(value, maxLen = 200) {
  if (!value || typeof value !== 'string') return '';
  return value
    .replace(ALLOWED_CHARS_RE, '')           // allow-list: 비허용 문자 제거
    .replace(/[\r\n\t]+/g, ' ')             // 줄바꿈 → 공백
    .replace(/(system|user|assistant|human)\s*:/gi, '[ROLE]') // role delimiter 치환
    .replace(/<\|[^|]+\|>/g, '')            // special token 제거
    .trim()
    .slice(0, maxLen);
}

// 외부(신뢰 불가) 텍스트를 untrusted 펜스로 격리
function wrapUntrusted(label, content) {
  if (!content) return '';
  return `\`\`\`untrusted-${label}\n${content}\n\`\`\``;
}

module.exports = { loadEnv, sanitizeForPrompt, wrapUntrusted };
