const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { envPathFor, getEnvValue, setEnvValue, clearEnvValue } = require('../out/env-file.js');
const { deriveSpawnCwd, extractBadge, routerScriptPath } = require('../out/router-bridge.js');
const { loadAgent } = require('../out/agents/loader.js');
const { HarnessPaths } = require('../out/state/paths.js');
const { checkCommand, checkFileWrite, loadGuards } = require('../out/tools/guards.js');

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function write(p, text) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, text, 'utf8');
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-extension-test-'));
  const harness = path.join(root, '.github');
  mkdirp(path.join(harness, 'agents'));
  mkdirp(path.join(harness, 'meta'));
  mkdirp(path.join(harness, 'hooks', 'scripts'));
  write(path.join(harness, 'hooks', 'scripts', 'maestro-router.js'), 'console.log("{}");\n');
  write(path.join(harness, 'meta', 'guards.json'), JSON.stringify({
    protectedDirs: ['hooks', 'agents', 'workflows', 'skills'],
    protectedFiles: ['maestro.agent.md'],
    sensitiveExtensions: ['.env', '.key', '.pem', '.crt', '.cer', '.p12', '.pfx', '.jks'],
    envFilenamePattern: '\\.env(\\.[a-z]+)?$',
    lockFiles: ['package-lock.json'],
    destructiveCommands: [
      { name: 'rm -rf', regex: '\\brm\\s+-[rRfF]{1,4}\\s', flags: 'i', appliesTo: ['js', 'py'] },
      { name: 'git push --force', regex: '\\bgit\\s+push\\s+.*--force(?!-with-lease)', flags: 'i', appliesTo: ['js'] },
      { name: 'drop table', regex: '\\bDROP\\s+TABLE\\b', flags: 'i', appliesTo: ['js', 'py'] }
    ]
  }, null, 2));
  write(path.join(harness, 'agents', 'planner.agent.md'), [
    '---',
    'name: Planner',
    'description: >',
    '  Plans changes before implementation.',
    'model: [ GPT-5, Claude Sonnet ]',
    '---',
    '# Planner',
    'Plan first.'
  ].join('\r\n'));
  write(path.join(harness, 'agents', 'context7.agent.md'), [
    '---',
    'name: Context7 Docs Agent',
    'description: Official docs lookup.',
    'model: GPT-5',
    '---',
    '# Context7',
    'Use official docs.'
  ].join('\n'));
  return { root, harness, paths: new HarnessPaths(harness) };
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  }
}

const fixture = makeHarness();

test('env-file preserves unrelated lines and edits GITHUB_PAT', () => {
  const envPath = envPathFor(fixture.harness);
  write(envPath, 'OTHER=value\n# comment\n');
  assert.strictEqual(getEnvValue(envPath, 'GITHUB_PAT'), null);
  const set = setEnvValue(envPath, 'GITHUB_PAT', 'ghp_test_1234567890');
  assert.strictEqual(set.keyExisted, false);
  assert.strictEqual(getEnvValue(envPath, 'GITHUB_PAT'), 'ghp_test_1234567890');
  assert.match(fs.readFileSync(envPath, 'utf8'), /OTHER=value/);
  const cleared = clearEnvValue(envPath, 'GITHUB_PAT');
  assert.strictEqual(cleared.written, true);
  assert.strictEqual(getEnvValue(envPath, 'GITHUB_PAT'), null);
});

test('router path helpers support standalone .github clone layout', () => {
  assert.strictEqual(deriveSpawnCwd(fixture.harness), fixture.root);
  assert.strictEqual(routerScriptPath(fixture.harness), path.join(fixture.harness, 'hooks', 'scripts', 'maestro-router.js'));
  assert.throws(() => deriveSpawnCwd(path.join(fixture.root, 'dotgithub')), /\.github/);
});

test('extractBadge finds Maestro fenced badge', () => {
  const badge = [
    '```',
    'noise',
    '```',
    '```',
    '🎯 **작업 유형**: question',
    '📋 **파이프라인**: Context7 Docs Agent → Critic → Release',
    '🔍 **분류 방식**: regex',
    '```'
  ].join('\n');
  const got = extractBadge(badge);
  assert.match(got, /작업 유형/);
  assert.match(got, /Context7 Docs Agent/);
});

test('agent loader handles CRLF frontmatter and first-word lookup', () => {
  const planner = loadAgent(fixture.paths, 'Planner');
  assert.ok(planner);
  assert.match(planner.description, /Plans changes/);
  assert.deepStrictEqual(planner.modelPreferences, ['GPT-5', 'Claude Sonnet']);
  assert.match(planner.systemPrompt, /Plan first/);
  const context7 = loadAgent(fixture.paths, 'Context7 Docs Agent');
  assert.ok(context7);
  assert.match(context7.systemPrompt, /official docs/i);
});

test('guards load SSOT and classify command/file writes', () => {
  const guards = loadGuards(fixture.paths);
  assert.ok(guards.protectedDirs.includes('agents'));
  assert.strictEqual(checkCommand(fixture.paths, 'rm -rf tmp').decision, 'deny');
  assert.strictEqual(checkCommand(fixture.paths, 'git push --force-with-lease').decision, 'allow');
  assert.strictEqual(checkCommand(fixture.paths, 'DROP TABLE users').decision, 'deny');
  assert.strictEqual(checkFileWrite(fixture.paths, 'src/index.ts').decision, 'allow');
  assert.strictEqual(checkFileWrite(fixture.paths, '.env').decision, 'deny');
  assert.strictEqual(checkFileWrite(fixture.paths, '.github/agents/planner.agent.md').decision, 'ask');
  assert.strictEqual(checkFileWrite(fixture.paths, path.join(fixture.root, '..', 'outside.txt')).decision, 'deny');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
