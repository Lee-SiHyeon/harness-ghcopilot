const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b[A-Za-z0-9._%+-]+:(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g,
  /\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,          // AWS Access Key
  /\bsk-[a-zA-Z0-9]{48}\b/g,        // OpenAI API Key
  /\bsk-ant-[a-zA-Z0-9\-_]{95}\b/g, // Anthropic API Key
  /\bxox[baprs]-[^\s"']{4,}/g,      // Slack Token
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, '[REDACTED]'), value);
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(item => redactUnknown(item));
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = /token|secret|password|authorization|pat|key/i.test(key)
      ? '[REDACTED]'
      : redactUnknown(item);
  }
  return redacted;
}
