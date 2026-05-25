const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { envPathFor, getEnvValue, setEnvValue, clearEnvValue } = require('../out/env-file.js');
const { deriveSpawnCwd, extractBadge, routerScriptPath, stripRouterDisplayDirectives } = require('../out/router-bridge.js');
const { loadAgent } = require('../out/agents/loader.js');
const { HarnessPaths } = require('../out/state/paths.js');
const { checkCommand, checkFileWrite, loadGuards } = require('../out/tools/guards.js');
const { isGitChangeQuery, renderGitChangeReport } = require('../out/local-git.js');
const {
  determineTestResult,
  getGateState,
  isEvidenceValid,
  isTestCommand,
  markFileChanged,
  recordTestEvidence,
} = require('../out/state/test-gate.js');
const { buildPipelineActionItems, finalizeRetrospective } = require('../out/state/retrospective.js');
const { loadActionItems } = require('../out/state/action-items.js');

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

test('stripRouterDisplayDirectives removes duplicated UI badge instructions', () => {
  const raw = [
    '## [⚠️ 필수 — 응답 첫 줄 출력 의무]',
    '아래 블록을 **응답의 첫 줄로** 반드시 출력한다.',
    '```',
    '🎯 **작업 유형**: query',
    '📋 **파이프라인**: Context7 Docs Agent → Critic → Release',
    '🔍 **분류 방식**: regex',
    '```',
    '이 블록 없이 내용을 출력하거나 에이전트를 호출하면 규칙 위반이다.',
    '',
    '## [원본 요청]',
    '변경 들어온게 뭐지?'
  ].join('\n');
  const stripped = stripRouterDisplayDirectives(raw);
  assert.doesNotMatch(stripped, /작업 유형/);
  assert.doesNotMatch(stripped, /파이프라인/);
  assert.match(stripped, /원본 요청/);
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

test('local git query detector and renderer are deterministic', () => {
  assert.strictEqual(isGitChangeQuery('변경 들어온게 뭐지?'), true);
  assert.strictEqual(isGitChangeQuery('git diff 보여줘'), true);
  assert.strictEqual(isGitChangeQuery('안녕'), false);
  const report = renderGitChangeReport({
    cwd: fixture.root,
    branch: 'main',
    status: ' M file.txt',
    unstagedStat: ' file.txt | 2 +-',
    stagedStat: '',
    recentCommits: 'abc123 test commit',
  });
  assert.match(report, /현재 git 기준 변경/);
  assert.match(report, /M file\.txt/);
  assert.match(report, /abc123/);
});

test('test-gate marks writes stale and accepts newer PASS evidence', () => {
  assert.strictEqual(isTestCommand('npm test'), true);
  assert.strictEqual(isTestCommand('node tests/maestro-suite.test.js'), true);
  assert.strictEqual(isTestCommand('echo hello'), false);
  assert.strictEqual(determineTestResult(0, 'all good'), 'PASS');
  assert.strictEqual(determineTestResult(1, 'failed'), 'FAIL');

  markFileChanged(fixture.paths, 'maestro_write_file', path.join(fixture.root, 'src', 'index.ts'));
  const gate = getGateState(fixture.paths);
  assert.ok(gate.requiredSince);
  assert.strictEqual(isEvidenceValid(fixture.paths), false);

  recordTestEvidence(fixture.paths, {
    command: 'npm test',
    result: 'PASS',
    status: 'PASS',
    exitCode: 0,
    evidence: 'PASS',
  });
  assert.strictEqual(isEvidenceValid(fixture.paths), true);
});

test('retrospective generates action items for missing suite agents', () => {
  const planned = ['Planner', 'Implementer', 'Tester', 'Critic', 'Release'];
  const results = [
    { agentName: 'Planner', output: 'plan', correlationId: 'a', durationMs: 1 },
    { agentName: 'Implementer', output: 'impl', correlationId: 'b', durationMs: 1 },
    { agentName: 'Release', output: 'done', correlationId: 'c', durationMs: 1 },
  ];
  const items = buildPipelineActionItems('implement', planned, results);
  assert.ok(items.some(i => i.agent === 'Tester'));
  assert.ok(items.some(i => i.agent === 'Critic'));

  markFileChanged(fixture.paths, 'maestro_write_file', path.join(fixture.root, 'src', 'changed.ts'));
  finalizeRetrospective(fixture.paths, {
    sessionId: 'session-test',
    intent: 'implement',
    plannedPipeline: planned,
    results,
    durationMs: 123,
  });
  const stored = loadActionItems(fixture.paths);
  assert.ok(stored.some(i => i.agent === 'Tester'));
  assert.ok(stored.some(i => i.source === 'testGate'));
  assert.ok(fs.existsSync(fixture.paths.retroJsonlPath));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
