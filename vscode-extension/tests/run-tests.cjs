const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { envPathFor, getEnvValue, setEnvValue, clearEnvValue } = require('../out/env-file.js');
const { deriveSpawnCwd, extractBadge, routerScriptPath, stripRouterDisplayDirectives } = require('../out/router-bridge.js');
const { loadAgent } = require('../out/agents/loader.js');
const { displayRelativePath, HarnessPaths, resolveWorkspacePath } = require('../out/state/paths.js');
const { checkCommand, checkFileWrite, loadGuards } = require('../out/tools/guards.js');
const { appendPipelineStep } = require('../out/state/pipeline-log.js');
const { redactSecrets } = require('../out/state/redaction.js');
const { isGitChangeQuery, renderGitChangeReport } = require('../out/local-git.js');
const { classifyPrompt, buildBadge, buildInternalUserMessage } = require('../out/router/internal.js');
const { loadPipelineConfig, normalizePipeline } = require('../out/pipeline/config.js');
const { inspectMcpStatus, MCP_TOOL_NAMES } = require('../out/mcp-status.js');
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
const { createLogger } = require('../out/logging.js');
const { npmTestSpawnSpec, runNpmTest } = require('../out/test-runner.js');
const { choosePreferredModel, scoreModel } = require('../out/model-selection.js');

const pendingTests = [];

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
  mkdirp(path.join(harness, 'mcp-server', 'dist'));
  write(path.join(harness, 'hooks', 'scripts', 'maestro-router.js'), 'console.log("{}");\n');
  write(path.join(harness, 'mcp-server', 'dist', 'index.js'), 'console.log("mcp");\n');
  write(path.join(harness, 'mcp-server', 'package.json'), '{"name":"mcp-server"}\n');
  write(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node tests/run-tests.cjs' } }));
  write(path.join(harness, 'meta', 'guards.json'), JSON.stringify({
    protectedDirs: ['hooks', 'agents', 'workflows', 'skills'],
    protectedFiles: ['maestro.agent.md'],
    sensitiveExtensions: ['.env', '.key', '.pem', '.crt', '.cer', '.p12', '.pfx', '.jks'],
    envFilenamePattern: '\\.env[^/]*$',
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
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingTests.push(result.then(
        () => console.log(`PASS ${name}`),
        (e) => {
          console.error(`FAIL ${name}`);
          console.error(e && e.stack ? e.stack : e);
          process.exitCode = 1;
        },
      ));
      return;
    }
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
  assert.strictEqual(checkCommand(fixture.paths, 'git push --force-with-lease').decision, 'deny');
  assert.strictEqual(checkCommand(fixture.paths, 'npm test').decision, 'allow');
  assert.strictEqual(checkCommand(fixture.paths, 'echo npm test').decision, 'deny');
  assert.strictEqual(checkCommand(fixture.paths, 'npm test || true').decision, 'deny');
  assert.strictEqual(checkCommand(fixture.paths, 'npm test > out.txt').decision, 'deny');
  assert.strictEqual(checkCommand(fixture.paths, 'DROP TABLE users').decision, 'deny');
  assert.strictEqual(checkFileWrite(fixture.paths, 'src/index.ts').decision, 'allow');
  assert.strictEqual(checkFileWrite(fixture.paths, '.env').decision, 'deny');
  assert.strictEqual(checkFileWrite(fixture.paths, '.github/agents/planner.agent.md').decision, 'ask');
  assert.strictEqual(checkFileWrite(fixture.paths, path.join(fixture.root, '..', 'outside.txt')).decision, 'deny');
});


test('workspace-aware path resolver allows active workspace and harness roots only', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-workspace-root-'));
  const harness = path.join(workspaceRoot, '.github');
  mkdirp(path.join(harness, 'agents'));
  const paths = new HarnessPaths(harness, workspaceRoot);
  const insideWorkspace = resolveWorkspacePath(paths, path.join(workspaceRoot, 'src', 'app.ts'));
  assert.strictEqual(insideWorkspace.allowed, true);
  assert.strictEqual(insideWorkspace.rel, 'src/app.ts');
  const insideHarness = resolveWorkspacePath(paths, path.join(harness, 'agents', 'planner.agent.md'));
  assert.strictEqual(insideHarness.allowed, true);
  assert.strictEqual(insideHarness.rel, '.github/agents/planner.agent.md');
  assert.strictEqual(displayRelativePath(paths, insideHarness.abs), '.github/agents/planner.agent.md');
  const outside = resolveWorkspacePath(paths, path.join(workspaceRoot, '..', 'outside.txt'));
  assert.strictEqual(outside.allowed, false);
});

test('guards allow configured workspace root while preserving harness protections', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-active-workspace-'));
  const harness = path.join(workspaceRoot, '.github');
  mkdirp(path.join(harness, 'meta'));
  write(path.join(harness, 'meta', 'guards.json'), JSON.stringify({
    protectedDirs: ['agents'],
    protectedFiles: ['maestro.agent.md'],
    sensitiveExtensions: ['.env', '.key'],
    envFilenamePattern: '\\.env(\\.[a-z]+)?$',
    lockFiles: [],
    destructiveCommands: []
  }));
  const paths = new HarnessPaths(harness, workspaceRoot);
  assert.strictEqual(checkFileWrite(paths, path.join(workspaceRoot, 'src', 'index.ts')).decision, 'allow');
  assert.strictEqual(checkFileWrite(paths, path.join(harness, 'agents', 'planner.agent.md')).decision, 'ask');
  assert.strictEqual(checkFileWrite(paths, path.join(workspaceRoot, '..', 'outside.txt')).decision, 'deny');
});


test('path resolver blocks symlink traversal out of workspace', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-symlink-workspace-'));
  const harness = path.join(workspaceRoot, '.github');
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-symlink-outside-'));
  mkdirp(harness);
  write(path.join(outsideRoot, 'secret.txt'), 'secret');
  const linkPath = path.join(workspaceRoot, 'linked');
  try {
    fs.symlinkSync(outsideRoot, linkPath, 'dir');
  } catch {
    return;
  }
  const paths = new HarnessPaths(harness, workspaceRoot);
  const resolved = resolveWorkspacePath(paths, path.join(linkPath, 'secret.txt'));
  assert.strictEqual(resolved.allowed, false);
  assert.strictEqual(resolved.symlinkBlocked, true);
});

test('MCP status exposes github-state tool surface and shared state files', () => {
  write(path.join(fixture.harness, 'logs', 'current-todos.json'), '{"todos":[]}\n');
  write(path.join(fixture.harness, 'logs', 'subagent-flow.jsonl'), '');
  write(path.join(fixture.harness, 'logs', 'retrospective-draft.json'), '{"actionItems":[]}\n');
  write(path.join(fixture.harness, 'logs', 'test-evidence.json'), '{"status":"PASS"}\n');
  write(path.join(fixture.harness, 'logs', 'test-gate-state.json'), '{}\n');
  write(path.join(fixture.harness, 'logs', 'retro.jsonl'), '');
  const status = inspectMcpStatus(fixture.harness);
  assert.strictEqual(status.distExists, true);
  assert.strictEqual(status.packageExists, true);
  assert.ok(MCP_TOOL_NAMES.includes('todo_get'));
  assert.ok(MCP_TOOL_NAMES.includes('testgate_is_valid'));
  assert.ok(MCP_TOOL_NAMES.includes('retro_get_recent'));
  assert.strictEqual(Object.values(status.sharedState).filter(Boolean).length, 6);
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

test('internal TS router normalizes pipelines and builds badge without legacy hook', () => {
  const config = loadPipelineConfig(fixture.paths);
  assert.ok(config.pipelines.length >= 1);
  assert.deepStrictEqual(
    normalizePipeline('implement', ['Planner', 'Implementer', 'Reviewer', 'Critic', 'Release']),
    ['Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'],
  );
  const analysis = classifyPrompt('React 컴포넌트 구현해줘', fixture.paths);
  assert.strictEqual(analysis.intent, 'implement');
  assert.ok(analysis.pipeline.includes('Tester'));
  assert.strictEqual(analysis.pipeline[0], 'Context7 Docs Agent');
  const badge = buildBadge(analysis);
  assert.match(badge, /Extension TS router/);
  const msg = buildInternalUserMessage(analysis, 'React 컴포넌트 구현해줘', fixture.paths);
  assert.match(msg, /파이프라인 강제/);
  assert.match(msg, /원본 요청/);
});

test('internal TS router keeps read-only questions away from Release', () => {
  const question = classifyPrompt('안녕?', fixture.paths);
  assert.strictEqual(question.intent, 'question');
  assert.deepStrictEqual(question.pipeline, []);
  assert.match(buildBadge(question), /직접 답변/);
  assert.doesNotMatch(buildInternalUserMessage(question, '안녕?', fixture.paths), /Release/);

  const inspect = classifyPrompt('지금 이 익스텐션에서 부족한게 뭐냐', fixture.paths);
  assert.strictEqual(inspect.intent, 'inspect');
  assert.deepStrictEqual(inspect.pipeline, ['Inspector']);
  assert.strictEqual(inspect.needs_todo, false);
});


test('internal TS router keeps library questions direct unless Context7 is explicit', () => {
  const reactQuestion = classifyPrompt('React가 뭐야?', fixture.paths);
  assert.strictEqual(reactQuestion.intent, 'question');
  assert.deepStrictEqual(reactQuestion.pipeline, []);

  const vscodeQuestion = classifyPrompt('VS Code extension 설명해줘', fixture.paths);
  assert.strictEqual(vscodeQuestion.intent, 'question');
  assert.deepStrictEqual(vscodeQuestion.pipeline, []);

  const context7Code = classifyPrompt('Context7로 React hook 코드 작성해줘', fixture.paths);
  assert.strictEqual(context7Code.intent, 'implement');
  assert.strictEqual(context7Code.pipeline[0], 'Context7 Docs Agent');
});
test('internal TS router injects saved todo and precompact resume blocks', () => {
  write(path.join(fixture.harness, 'logs', 'current-todos.json'), JSON.stringify({
    todos: [{ id: 1, title: 'finish migration', status: 'in-progress' }]
  }));
  write(path.join(fixture.harness, 'logs', 'precompact-state.json'), JSON.stringify({
    ts: '2026-05-25T00:00:00.000Z',
    todos: { inProgress: [{ title: 'resume this' }] },
    gitStatus: [' M file.ts']
  }));
  const analysis = classifyPrompt('계획 세워줘', fixture.paths);
  const msg = buildInternalUserMessage(analysis, '계획 세워줘', fixture.paths);
  assert.match(msg, /현재 Todo 상태/);
  assert.match(msg, /세션 재개/);
  assert.match(msg, /finish migration/);
});

test('internal TS router treats missing or not-wired reports as fix', () => {
  const analysis = classifyPrompt('왜 Tester가 pipeline에 안 연결된 것 같지?', fixture.paths);
  assert.strictEqual(analysis.intent, 'fix');
  assert.deepStrictEqual(analysis.pipeline, ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release']);
});

test('extension router parity matrix covers hook classifier core intents', () => {
  const cases = [
    ['리뷰해줘', 'review', ['Reviewer']],
    ['왜 그래?', 'question', []],
    ['문서화해줘', 'document', ['Context7 Docs Agent', 'Documenter', 'Critic', 'Release']],
    ['없는 것 같지?', 'question', []],
    ['누락됐어', 'fix', ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release']],
    ['버그 고쳐', 'fix', ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release']],
    ['설계해줘', 'plan', ['Planner']],
    ['릴리즈해줘', 'release', ['Release', 'Critic']],
    ['만들어줘', 'implement', ['Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release']],
    ['문제점들 고쳐줘', 'fix', ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release']],
  ];
  for (const [prompt, intent, pipeline] of cases) {
    const analysis = classifyPrompt(prompt, fixture.paths);
    assert.strictEqual(analysis.intent, intent, prompt);
    assert.deepStrictEqual(analysis.pipeline, pipeline, prompt);
  }
});

test('extension router broad simulation covers 100+ user inputs', () => {
  const cases = [
    ['안녕?', 'question'], ['오늘 뭐 할 수 있어?', 'question'], ['이 확장 뭐야?', 'question'], ['사용법 알려줘', 'question'],
    ['VS Code extension 설명해줘', 'question'], ['React가 뭐야?', 'question'], ['Next.js middleware가 뭐야?', 'question'],
    ['Copilot Chat 한계가 뭐야?', 'question'], ['마에스트로 구조 요약해줘', 'question'], ['이전 대화 기억해?', 'question'],
    ['없는 것 같지?', 'question'], ['이거 이상하지 않냐?', 'question'], ['괜찮아 보임?', 'question'], ['뭐부터 하지?', 'question'],
    ['just answer shortly', 'query'], ['status 확인', 'query'], ['다음 진행 알아서', 'query'],
    ['지금 이 익스텐션에서 부족한게 뭐냐', 'inspect'], ['개선점 분석해와', 'inspect'], ['아쉬운 점 알려줘', 'inspect'],
    ['문제점 정리해줘', 'inspect'], ['보완할 부분 찾아줘', 'inspect'], ['빠져 있는 기능이 있나?', 'inspect'],
    ['what is missing in this extension?', 'inspect'], ['what features are lacking?', 'inspect'], ['코드베이스 약점 분석', 'inspect'],
    ['병목 찾아줘', 'inspect'], ['MCP 상태뷰 개선점', 'inspect'], ['subagent 하네싱 평가해줘', 'inspect'],
    ['read-only 분석만 해줘', 'inspect'], ['tool schema 부족한 점', 'inspect'],
    ['리뷰해줘', 'review'], ['코드 리뷰해줘', 'review'], ['보안 검토해줘', 'review'], ['점검해', 'review'],
    ['audit this', 'review'], ['확인해줘', 'review'], ['single-session 설계 검토', 'review'], ['보안 취약점 찾아줘', 'review'],
    ['테스트가 stale인지 확인해줘', 'review'], ['파일 수정하지 말고 봐줘', 'review'], ['수정하지 말고 문제점만', 'review'],
    ['review security of agent tool', 'review'],
    ['설계해줘', 'plan'], ['계획 세워줘', 'plan'], ['어떻게 구현할지 알려줘', 'plan'], ['아키텍처 잡아줘', 'plan'],
    ['design the flow', 'plan'], ['plan Phase 9', 'plan'],
    ['버그 고쳐', 'fix'], ['에러 수정해줘', 'fix'], ['안 돼 고쳐줘', 'fix'], ['왜 테스트가 실패하지? 고쳐줘', 'fix'],
    ['누락됐어', 'fix'], ['Tester가 안 연결된 것 같지?', 'fix'], ['pipeline missing agent fix', 'fix'], ['not wired pipeline 고쳐', 'fix'],
    ['이 문제 해결해줘', 'fix'], ['crash 고쳐줘', 'fix'], ['로그가 안 찍혀 고쳐줘', 'fix'], ['executor OOM 문제 수정', 'fix'],
    ['Slack token push protection 해결', 'fix'], ['자동으로 고쳐줘', 'fix'], ['CI 고쳐줘', 'fix'], ['MCP tool schema 누락됐어', 'fix'],
    ['fix agent tool context leak', 'fix'],
    ['왜 안 됨?', 'investigate'], ['원인 조사해줘', 'investigate'], ['디버깅해줘', 'investigate'], ['왜 실패했는지 봐줘', 'investigate'],
    ['root cause 찾아줘', 'investigate'], ['test-gate race condition 조사', 'investigate'], ['Release gate 왜 막힘?', 'investigate'],
    ['배지 안 보여 왜?', 'investigate'], ['마에스트로가 이상하게 대답해', 'investigate'], ['why context history missing?', 'investigate'],
    ['CI 실패 원인', 'investigate'],
    ['만들어줘', 'implement'], ['새 기능 추가해줘', 'implement'], ['구현해줘', 'implement'], ['파일 생성해줘', 'implement'],
    ['build a dashboard', 'implement'], ['마이그레이션해줘', 'implement'], ['테스트 작성해줘', 'implement'],
    ['redaction 기능 추가해줘', 'implement'], ['Context7로 React hook 코드 작성해줘', 'implement'], ['VS Code command 추가해줘', 'implement'],
    ['프롬프트 라우터 리팩토링해줘', 'implement'], ['로그 secret redaction 보강', 'implement'],
    ['Context7 공식 문서 기반 Next.js middleware 구현', 'implement'], ['성능 최적화해줘', 'implement'], ['코드 정리해줘', 'implement'],
    ['구조 바꿔줘', 'implement'], ['100개 입력 시뮬레이션 테스트 추가해줘', 'implement'], ['implement isolated context map', 'implement'],
    ['improve context history', 'implement'], ['이 코드 만들어', 'implement'], ['regression test 추가', 'implement'],
    ['문서화해줘', 'document'], ['README 정리해줘', 'document'], ['docs update', 'document'], ['API 레퍼런스 만들어줘', 'document'],
    ['설명 문서 작성해줘', 'document'], ['OpenAI API 문서화', 'document'], ['document Phase 9', 'document'],
    ['릴리즈해줘', 'release'], ['배포해', 'release'], ['버전 올려', 'release'], ['publish package', 'release'],
    ['tag release', 'release'], ['커밋하고 푸시해', 'release'], ['deploy vsix', 'release'],
    ['자기개선 탐색해줘', 'scout'], ['최신 패턴 찾아줘', 'scout'], ['GitHub stars 조사', 'scout'],
    ['Scout로 트렌드 분석', 'scout'], ['awesome-harness-engineering 찾아봐', 'scout'],
    ['Scout Ralph Loop 돌려', 'scout_loop'], ['scout loop 완료까지', 'scout_loop'], ['자기개선 루프 실행', 'scout_loop'],
  ];

  assert.ok(cases.length >= 100);
  for (const [prompt, expected] of cases) {
    const analysis = classifyPrompt(prompt, fixture.paths);
    assert.strictEqual(analysis.intent, expected, prompt);
    const normalized = analysis.pipeline[0] === 'Context7 Docs Agent' && ['implement', 'fix', 'plan'].includes(expected)
      ? analysis.pipeline.slice(1)
      : analysis.pipeline;
    if (expected === 'question' || expected === 'query') assert.deepStrictEqual(analysis.pipeline, [], prompt);
    if (expected === 'inspect') assert.deepStrictEqual(analysis.pipeline, ['Inspector'], prompt);
    if (expected === 'review') assert.deepStrictEqual(analysis.pipeline, ['Reviewer'], prompt);
    if (expected === 'plan') assert.deepStrictEqual(normalized, ['Planner'], prompt);
    if (expected === 'investigate') assert.deepStrictEqual(analysis.pipeline, ['Investigator'], prompt);
    if (expected === 'fix') assert.deepStrictEqual(normalized, ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'], prompt);
    if (expected === 'implement') assert.deepStrictEqual(normalized, ['Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'], prompt);
    if (expected === 'document') assert.deepStrictEqual(analysis.pipeline, ['Context7 Docs Agent', 'Documenter', 'Critic', 'Release'], prompt);
    if (expected === 'release') assert.deepStrictEqual(analysis.pipeline, ['Release', 'Critic'], prompt);
    if (expected === 'scout') assert.deepStrictEqual(analysis.pipeline, ['Scout'], prompt);
    if (expected === 'scout_loop') assert.deepStrictEqual(analysis.pipeline, ['Scout', 'Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'], prompt);
    if (['question', 'query', 'inspect', 'review', 'plan', 'investigate', 'scout'].includes(expected)) {
      assert.ok(!analysis.pipeline.includes('Release'), prompt);
    }
    if (['fix', 'implement', 'scout_loop'].includes(expected)) {
      assert.ok(analysis.pipeline.includes('Tester'), prompt);
    }
  }
});

test('extension package contributes MCP view and commands', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const views = pkg.contributes.views.maestroChat.map(v => v.id);
  assert.ok(views.includes('maestroChat.sidebar'));
  assert.ok(views.includes('maestroChat.mcp'));
  const commands = pkg.contributes.commands.map(c => c.command);
  assert.ok(commands.includes('maestroChat.openMcpConfig'));
  assert.ok(commands.includes('maestroChat.runExtensionTests'));
  const tools = pkg.contributes.languageModelTools.map(t => t.name);
  assert.ok(tools.includes('maestro_list_files'));
  assert.ok(tools.includes('maestro_search_files'));
  const searchFiles = pkg.contributes.languageModelTools.find(t => t.name === 'maestro_search_files');
  assert.strictEqual(searchFiles.inputSchema.properties.regex.type, 'boolean');
  assert.ok(tools.includes('maestro_invoke_agent'));
  const invokeAgent = pkg.contributes.languageModelTools.find(t => t.name === 'maestro_invoke_agent');
  assert.ok(invokeAgent.inputSchema.required.includes('context_id'));
  const executorMode = pkg.contributes.configuration.properties['maestroChat.executorMode'];
  assert.ok(executorMode.enum.includes('single-session'));
  assert.strictEqual(executorMode.default, 'single-session');
  assert.match(executorMode.description, /extension-driven/);
  assert.match(executorMode.enumDescriptions[1], /Tester retry/);
});

test('model selection avoids premium Opus as the default first choice', () => {
  const opus = { name: 'Claude Opus 4.6', vendor: 'copilot', family: 'claude-opus-4.6' };
  const sonnet = { name: 'Claude Sonnet 4.6', vendor: 'copilot', family: 'claude-sonnet-4.6' };
  const mini = { name: 'GPT-4.1 Mini', vendor: 'copilot', family: 'gpt-4.1-mini' };
  assert.ok(scoreModel(opus) > scoreModel(sonnet));
  assert.strictEqual(choosePreferredModel([opus, sonnet]), sonnet);
  assert.strictEqual(choosePreferredModel([opus, mini, sonnet]), mini);
});

test('test-gate marks writes stale and accepts newer PASS evidence', () => {
  const { root, harness, paths } = makeHarness();
  try {
    assert.strictEqual(isTestCommand('npm test'), true);
    assert.strictEqual(isTestCommand('echo npm test'), false);
    assert.strictEqual(isTestCommand('npm test || true'), false);
    assert.strictEqual(isTestCommand('echo hello'), false);
    assert.strictEqual(determineTestResult(0, 'all good'), 'FAIL');
    assert.strictEqual(determineTestResult(0, '19 PASS'), 'PASS');
    assert.strictEqual(determineTestResult(1, 'failed'), 'FAIL');

    markFileChanged(paths, 'maestro_write_file', path.join(root, 'src', 'index.ts'));
    const gate = getGateState(paths);
    assert.ok(gate.requiredSince);
    assert.strictEqual(isEvidenceValid(paths), false);

    recordTestEvidence(paths, {
      command: 'npm test',
      result: 'PASS',
      status: 'PASS',
      exitCode: 0,
      evidence: 'PASS',
    });
    assert.strictEqual(isEvidenceValid(paths), true);
  } finally {
    require('fs').rmSync(root, { recursive: true, force: true });
  }
});


test('redaction scrubs secrets from logs and evidence', () => {
  const ghToken = 'gh' + 'p_' + '123456789012345678901234567890123456';
  const secret = 'token=' + ghToken;
  assert.doesNotMatch(redactSecrets(secret), /ghp_/);
  recordTestEvidence(fixture.paths, {
    command: 'npm test',
    result: 'FAIL',
    status: 'FAIL',
    exitCode: 1,
    evidence: secret,
  });
  const evidenceText = fs.readFileSync(fixture.paths.testEvidencePath, 'utf8');
  assert.doesNotMatch(evidenceText, /ghp_/);
  appendPipelineStep(fixture.paths, {
    step: 'redaction-test',
    output: secret,
    extra: { token: ghToken },
  });
  const pipelineText = fs.readFileSync(fixture.paths.log('pipeline.jsonl'), 'utf8');
  assert.doesNotMatch(pipelineText, /ghp_/);
  // AWS Access Key
  const awsKey = 'AK' + 'IA' + '1234567890ABCDEF';
  assert.doesNotMatch(redactSecrets('my key ' + awsKey + ' end'), new RegExp(awsKey));
  // OpenAI API Key (48 chars)
  const openAiToken = 's' + 'k-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL';
  assert.doesNotMatch(redactSecrets('key ' + openAiToken + ' end'), new RegExp(openAiToken));
  // Anthropic API Key
  assert.doesNotMatch(redactSecrets('sk-ant-api03-' + 'a'.repeat(89)), /sk-ant-api03-/);
  // Slack Token
  const slackToken = 'xo' + 'xb-' + '123456789012-1234567890123-abcdefghijklmnopqrstuvwx';
  assert.doesNotMatch(redactSecrets('token ' + slackToken), new RegExp(slackToken.slice(0, 17)));
});
test('logger redacts secrets from messages and structured data', () => {
  const token = 'ghp_' + '1'.repeat(36);
  const bearer = 'Bearer ' + 'a'.repeat(32);
  const apiKey = 'abcdef1234567890';
  const lines = [];
  const logger = createLogger({
    appendLine(line) { lines.push(line); },
    show() {},
  });
  logger.info(`token=${token}`, {
    input: bearer,
    nested: { password: 'super-secret-value' },
  });
  logger.error('failed', new Error(`api_key=${apiKey}`));
  const text = lines.join('\n');
  assert.doesNotMatch(text, /ghp_/);
  assert.doesNotMatch(text, new RegExp(bearer));
  assert.doesNotMatch(text, /super-secret-value/);
  assert.doesNotMatch(text, new RegExp(apiKey));
  assert.match(text, /\[REDACTED\]/);
});

test('npm test runner uses spawn without shell and captures passing output', async () => {
  const spec = npmTestSpawnSpec();
  assert.strictEqual(spec.shell, false);
  if (process.platform === 'win32') {
    assert.strictEqual(path.basename(spec.command).toLowerCase(), 'cmd.exe');
    assert.deepStrictEqual(spec.args, ['/d', '/s', '/c', 'npm.cmd', 'test']);
  } else {
    assert.strictEqual(spec.command, 'npm');
    assert.deepStrictEqual(spec.args, ['test']);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-npm-test-runner-'));
  const fakeRunner = path.join(root, 'fake-runner.cjs');
  write(fakeRunner, 'console.log("PASS runner");\n');
  const run = await runNpmTest(root, 30_000, {
    command: process.execPath,
    args: [fakeRunner],
    shell: false,
  });
  assert.strictEqual(run.exitCode, 0);
  assert.strictEqual(run.timedOut, false);
  assert.match(run.stdout, /PASS runner/);
});
test('retrospective generates action items for missing suite agents', () => {
  const { root, harness, paths } = makeHarness();
  try {
    const planned = ['Planner', 'Implementer', 'Tester', 'Critic', 'Release'];
    const results = [
      { agentName: 'Planner', output: 'plan', correlationId: 'a', durationMs: 1 },
      { agentName: 'Implementer', output: 'impl', correlationId: 'b', durationMs: 1 },
      { agentName: 'Release', output: 'done', correlationId: 'c', durationMs: 1 },
    ];
    const items = buildPipelineActionItems('implement', planned, results);
    assert.ok(items.some(i => i.agent === 'Tester'));
    assert.ok(items.some(i => i.agent === 'Critic'));
    assert.strictEqual(buildPipelineActionItems('inspect', ['Inspector'], [
      { agentName: 'Inspector', output: 'report', correlationId: 'i', durationMs: 1 },
    ]).some(i => i.agent === 'Critic' || i.agent === 'Release'), false);

    markFileChanged(paths, 'maestro_write_file', path.join(root, 'src', 'changed.ts'));
    finalizeRetrospective(paths, {
      sessionId: 'session-test',
      intent: 'implement',
      plannedPipeline: planned,
      results,
      durationMs: 123,
    });
    const stored = loadActionItems(paths);
    assert.ok(stored.some(i => i.agent === 'Tester'));
    assert.ok(stored.some(i => i.source === 'testGate'));
    assert.ok(fs.existsSync(paths.retroJsonlPath));
  } finally {
    require('fs').rmSync(root, { recursive: true, force: true });
  }
});




test('agent-tool: AGENT_TOOL_NAME constant and MAX_INVOKE_DEPTH', () => {
  const { AGENT_TOOL_NAME, MAX_INVOKE_DEPTH } = require('../out/tools/agent-constants.js');
  assert.strictEqual(AGENT_TOOL_NAME, 'maestro_invoke_agent');
  assert.strictEqual(MAX_INVOKE_DEPTH, 2);
});

test('agent-tool: validateInvokeInput rejects null model', () => {
  const { validateInvokeInput } = require('../out/tools/agent-constants.js');
  const err = validateInvokeInput({ id: 'ctx-a', model: null, paths: {}, toolToken: undefined, depth: 0 }, { context_id: 'ctx-a', agent_name: 'Planner', task: 'test' });
  assert.ok(err !== null, 'Should return error for null model');
  assert.ok(err.includes('⚠'), 'Should be warning msg: ' + err);
});

test('agent-tool: validateInvokeInput blocks depth overflow', () => {
  const { validateInvokeInput, MAX_INVOKE_DEPTH } = require('../out/tools/agent-constants.js');
  const err = validateInvokeInput({ id: 'ctx-a', model: {}, paths: {}, toolToken: undefined, depth: MAX_INVOKE_DEPTH }, { context_id: 'ctx-a', agent_name: 'X', task: 'y' });
  assert.ok(err !== null, 'Should fail at max depth');
});

test('agent-tool: validateInvokeInput requires matching context_id', () => {
  const { validateInvokeInput } = require('../out/tools/agent-constants.js');
  const missing = validateInvokeInput({ id: 'ctx-a', model: {}, paths: {}, toolToken: undefined, depth: 0 }, { agent_name: 'Reviewer', task: 'check' });
  assert.ok(missing.includes('context_id'));
  const mismatch = validateInvokeInput({ id: 'ctx-a', model: {}, paths: {}, toolToken: undefined, depth: 0 }, { context_id: 'ctx-b', agent_name: 'Reviewer', task: 'check' });
  assert.ok(mismatch.includes('일치하지'));
});

test('agent-tool: validateInvokeInput passes valid inputs', () => {
  const { validateInvokeInput } = require('../out/tools/agent-constants.js');
  const ok = validateInvokeInput({ id: 'ctx-a', model: {}, paths: {}, toolToken: undefined, depth: 0 }, { context_id: 'ctx-a', agent_name: 'Reviewer', task: 'check' });
  assert.strictEqual(ok, null);
});



Promise.all(pendingTests).then(() => {
  if (process.exitCode) {
    process.exit(process.exitCode);
  }
});
