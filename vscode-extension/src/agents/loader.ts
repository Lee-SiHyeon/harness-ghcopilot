import * as fs from 'fs';
import { HarnessPaths } from '../state/paths';

export interface AgentDefinition {
  name: string;
  description: string;
  /** YAML frontmatter 안의 model 필드 (list 또는 string). */
  modelPreferences: string[];
  /** YAML frontmatter 안의 tools 필드. VS Code/OMG agent metadata와 호환. */
  toolPreferences: string[];
  /** YAML frontmatter 안의 agents 필드. 이 agent가 위임할 수 있는 subagent 목록. */
  delegatedAgents: string[];
  /** user-invocable frontmatter 값. 없으면 true로 간주. */
  userInvocable: boolean;
  /** 시스템 프롬프트로 사용할 본문 (frontmatter 제거됨). */
  systemPrompt: string;
  /** 실제 로드된 파일명. */
  fileName?: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function readFirstWord(name: string): string {
  return name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9-]/g, '');
}

/**
 * Agent 이름으로 .agent.md 파일을 찾아 파싱한다.
 *
 * 매칭 우선순위:
 *   1. {slug}.agent.md (kebab-case 변환)
 *   2. {firstWord}.agent.md (예: "Context7 Docs Agent" → "context7")
 *   3. {원이름}.agent.md (정확히 그 이름)
 *   4. 디렉토리 내 모든 .agent.md를 스캔하여 frontmatter name 일치 항목
 *
 * 못 찾으면 null 반환.
 */
export function loadAgent(paths: HarnessPaths, name: string): AgentDefinition | null {
  const slug = nameToSlug(name);
  const firstWord = readFirstWord(name);
  const candidates = [
    paths.agent(`${slug}.agent.md`),
    paths.agent(`${firstWord}.agent.md`),
    paths.agent(`${name}.agent.md`),
  ];
  let content: string | null = null;
  let fileName: string | undefined;
  for (const candidate of candidates) {
    try {
      content = fs.readFileSync(candidate, 'utf8');
      fileName = candidate.split(/[\\/]/).pop();
      break;
    } catch {
      /* try next */
    }
  }
  // 마지막 폴백: 디렉토리 스캔으로 name 매칭
  if (content === null) {
    const scanned = scanByName(paths, name);
    content = scanned?.content ?? null;
    fileName = scanned?.fileName;
  }
  if (content === null) return null;

  return parseAgentContent(content, name, fileName);
}

export function listAgents(paths: HarnessPaths): AgentDefinition[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(paths.agentsDir).filter(f => f.endsWith('.agent.md')).sort();
  } catch {
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const entry of entries) {
    try {
      const content = fs.readFileSync(paths.agent(entry), 'utf8');
      out.push(parseAgentContent(content, entry.replace(/\.agent\.md$/i, ''), entry));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function parseAgentContent(contentInput: string, fallbackName: string, fileName?: string): AgentDefinition {
  let content = contentInput;
  content = normalizeNewlines(content);
  const match = content.match(FRONTMATTER_RE);
  let frontmatterText = '';
  let body = content.trim();
  if (match) {
    frontmatterText = match[1];
    body = match[2].trim();
  }

  return {
    name: extractName(frontmatterText) || fallbackName,
    description: extractDescription(frontmatterText),
    modelPreferences: extractModelList(frontmatterText),
    toolPreferences: extractArrayOrSingle(frontmatterText, 'tools'),
    delegatedAgents: extractArrayOrSingle(frontmatterText, 'agents'),
    userInvocable: extractBoolean(frontmatterText, 'user-invocable', true),
    systemPrompt: body,
    fileName,
  };
}

function scanByName(paths: HarnessPaths, name: string): { content: string; fileName: string } | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(paths.agentsDir).filter(f => f.endsWith('.agent.md'));
  } catch {
    return null;
  }
  for (const entry of entries) {
    try {
      const fd = fs.openSync(paths.agent(entry), 'r');
      const buf = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      const raw = normalizeNewlines(buf.slice(0, bytesRead).toString('utf8'));
      const nameMatch = raw.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
      if (nameMatch && nameMatch[1].trim() === name) {
        return { content: fs.readFileSync(paths.agent(entry), 'utf8'), fileName: entry };
      }
    } catch {
      /* skip unreadable */
    }
  }
  return null;
}

function extractName(frontmatter: string): string {
  const match = frontmatter.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
  return match ? match[1].trim() : '';
}

function extractDescription(frontmatter: string): string {
  // description: >\n  multi-line\n  ...
  const blockMatch = frontmatter.match(/^description:\s*[>|]\s*\n((?:\s+.*\n?)+)/m);
  if (blockMatch) {
    return blockMatch[1].split('\n').map(l => l.trim()).filter(Boolean).join(' ').slice(0, 200);
  }
  // description: single line
  const inlineMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (inlineMatch) {
    return inlineMatch[1].trim().slice(0, 200);
  }
  return '';
}

function extractModelList(frontmatter: string): string[] {
  return extractArrayOrSingle(frontmatter, 'model');
}

function extractArrayOrSingle(frontmatter: string, key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // model: [ Foo (copilot), Bar ]
  const inlineMatch = frontmatter.match(new RegExp(`^${escaped}:\\s*\\[(.+?)\\]\\s*$`, 'm'));
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  // model: Foo
  const singleMatch = frontmatter.match(new RegExp(`^${escaped}:\\s*['"]?([^'"\\n\\[]+?)['"]?\\s*$`, 'm'));
  if (singleMatch) {
    return [singleMatch[1].trim()];
  }
  return [];
}

function extractBoolean(frontmatter: string, key: string, fallback: boolean): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = frontmatter.match(new RegExp(`^${escaped}:\\s*(true|false)\\s*$`, 'im'));
  if (!match) return fallback;
  return match[1].toLowerCase() === 'true';
}
