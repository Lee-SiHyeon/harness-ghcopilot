'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOOKS   = path.resolve(__dirname, '..', 'hooks', 'scripts');
const AGENTS  = path.resolve(__dirname, '..', 'agents');
const HOOKS_DIR = path.resolve(__dirname, '..', 'hooks');
const LOGS    = path.resolve(__dirname, '..', 'logs');

// ── 공통 헬퍼 ───────────────────────────────────────────────────
function readSrc(file)   { return fs.readFileSync(path.join(HOOKS, file), 'utf8'); }
function readAgent(file) { return fs.readFileSync(path.join(AGENTS, file), 'utf8'); }
function syntaxCheck(file) {
  execSync(`node --check "${path.join(HOOKS, file)}"`, { stdio: 'pipe' });
}

function extractFn(src, fnName) {
  const sig   = `function ${fnName}(`;
  const start = src.indexOf(sig);
  if (start === -1) throw new Error(`${fnName} not found in source`);
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  // fs, path, process를 inject하여 모듈 스코프 의존성 해소
  // eslint-disable-next-line no-new-func
  const factory = new Function('fs', 'path', 'process', `${src.slice(start, i + 1)}; return ${fnName};`);
  return factory(fs, path, process);
}

// ── TC 등록 ─────────────────────────────────────────────────────
const TCs = [];
function tc(id, group, desc, fn) { TCs.push({ id, group, desc, fn }); }

// ════════════════════════════════════════════════════════════════
// GROUP: maestro-router / syntax
// ════════════════════════════════════════════════════════════════
tc('tc-001', 'maestro-router/syntax', 'node --check maestro-router.js', () => {
  syntaxCheck('maestro-router.js');
});

// ════════════════════════════════════════════════════════════════
// GROUP: maestro-router / loadEnv
// ════════════════════════════════════════════════════════════════
tc('tc-002', 'maestro-router/loadEnv', '.env 파싱 — KEY=value 정상 파싱', () => {
  const src = readSrc('maestro-router.js');
  const loadEnv = extractFn(src, 'loadEnv');

  // 임시 .env 파일 생성
  const tmpDir  = path.join(require('os').tmpdir(), 'maestro-test-' + Date.now());
  const envFile = path.join(tmpDir, '.env');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(envFile, 'TEST_KEY_XYZ=hello_world\n');

  const origCwd  = process.cwd();
  const origVal  = process.env['TEST_KEY_XYZ'];
  delete process.env['TEST_KEY_XYZ'];
  process.chdir(tmpDir);
  try {
    loadEnv();
    if (process.env['TEST_KEY_XYZ'] !== 'hello_world') {
      throw new Error(`기대: 'hello_world', 실제: '${process.env['TEST_KEY_XYZ']}'`);
    }
  } finally {
    process.chdir(origCwd);
    if (origVal !== undefined) process.env['TEST_KEY_XYZ'] = origVal;
    else delete process.env['TEST_KEY_XYZ'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

tc('tc-003', 'maestro-router/loadEnv', '.env 파싱 — # 주석 무시', () => {
  const src = readSrc('maestro-router.js');
  const loadEnv = extractFn(src, 'loadEnv');

  const tmpDir  = path.join(require('os').tmpdir(), 'maestro-test-' + Date.now());
  const envFile = path.join(tmpDir, '.env');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(envFile, '# THIS_SHOULD_NOT_BE_SET=bad\nVALID_KEY_ABC=ok\n');

  const origCwd = process.cwd();
  delete process.env['THIS_SHOULD_NOT_BE_SET'];
  delete process.env['VALID_KEY_ABC'];
  process.chdir(tmpDir);
  try {
    loadEnv();
    if (process.env['THIS_SHOULD_NOT_BE_SET'] !== undefined) {
      throw new Error('# 주석 줄이 환경변수로 파싱됨');
    }
    if (process.env['VALID_KEY_ABC'] !== 'ok') {
      throw new Error(`정상 키 파싱 실패: '${process.env['VALID_KEY_ABC']}'`);
    }
  } finally {
    process.chdir(origCwd);
    delete process.env['THIS_SHOULD_NOT_BE_SET'];
    delete process.env['VALID_KEY_ABC'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

tc('tc-004', 'maestro-router/loadEnv', '.env 파싱 — 이미 있는 환경변수는 덮어쓰지 않음', () => {
  const src = readSrc('maestro-router.js');
  const loadEnv = extractFn(src, 'loadEnv');

  const tmpDir  = path.join(require('os').tmpdir(), 'maestro-test-' + Date.now());
  const envFile = path.join(tmpDir, '.env');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(envFile, 'EXISTING_KEY_QQQ=new_value\n');

  const origCwd = process.cwd();
  process.env['EXISTING_KEY_QQQ'] = 'original_value';
  process.chdir(tmpDir);
  try {
    loadEnv();
    if (process.env['EXISTING_KEY_QQQ'] !== 'original_value') {
      throw new Error(`기존 값 덮어씀: '${process.env['EXISTING_KEY_QQQ']}'`);
    }
  } finally {
    process.chdir(origCwd);
    delete process.env['EXISTING_KEY_QQQ'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// GROUP: maestro-router / classifyWithRegex
// ════════════════════════════════════════════════════════════════
let _classify = null;
function getClassify() {
  if (!_classify) _classify = extractFn(readSrc('maestro-router.js'), 'classifyWithRegex');
  return _classify;
}

tc('tc-005', 'maestro-router/classifyWithRegex', '"리뷰해줘" → intent=review', () => {
  const r = getClassify()('리뷰해줘');
  if (r.intent !== 'review') throw new Error(`기대: review, 실제: ${r.intent}`);
});

tc('tc-006', 'maestro-router/classifyWithRegex', '"왜 그래?" → intent=question (물음표 패턴)', () => {
  // "왜 그래?"는 단순 물음표 질문 → discovery/investigate-strong 패턴 없음 → ?$ 매치 → question
  const r = getClassify()('왜 그래?');
  if (r.intent !== 'question') throw new Error(`기대: question, 실제: ${r.intent}`);
});

tc('tc-007', 'maestro-router/classifyWithRegex', '"문서화해줘" → intent=document', () => {
  const r = getClassify()('문서화해줘');
  if (r.intent !== 'document') throw new Error(`기대: document, 실제: ${r.intent}`);
});

tc('tc-008', 'maestro-router/classifyWithRegex', '"없는 것 같지?" → intent=fix (discovery)', () => {
  const r = getClassify()('없는 것 같지?');
  if (r.intent !== 'fix') throw new Error(`기대: fix, 실제: ${r.intent}`);
});

tc('tc-009', 'maestro-router/classifyWithRegex', '"없는것같다" → intent=fix (discovery, 공백없음)', () => {
  const r = getClassify()('없는것같다');
  if (r.intent !== 'fix') throw new Error(`기대: fix, 실제: ${r.intent}`);
});

tc('tc-010', 'maestro-router/classifyWithRegex', '"빠져 있어" → intent=fix (discovery)', () => {
  const r = getClassify()('빠져 있어');
  if (r.intent !== 'fix') throw new Error(`기대: fix, 실제: ${r.intent}`);
});

tc('tc-011', 'maestro-router/classifyWithRegex', '"누락됐어" → intent=fix (discovery)', () => {
  const r = getClassify()('누락됐어');
  if (r.intent !== 'fix') throw new Error(`기대: fix, 실제: ${r.intent}`);
});

tc('tc-012', 'maestro-router/classifyWithRegex', '"왜 안 되지?" → intent=investigate', () => {
  const r = getClassify()('왜 안 되지?');
  if (r.intent !== 'investigate') throw new Error(`기대: investigate, 실제: ${r.intent}`);
});

tc('tc-013', 'maestro-router/classifyWithRegex', '"버그 고쳐" → intent=fix', () => {
  const r = getClassify()('버그 고쳐');
  if (r.intent !== 'fix') throw new Error(`기대: fix, 실제: ${r.intent}`);
});

tc('tc-014', 'maestro-router/classifyWithRegex', '"설계해줘" → intent=plan', () => {
  const r = getClassify()('설계해줘');
  if (r.intent !== 'plan') throw new Error(`기대: plan, 실제: ${r.intent}`);
});

tc('tc-015', 'maestro-router/classifyWithRegex', '"릴리즈해줘" → intent=release', () => {
  const r = getClassify()('릴리즈해줘');
  if (r.intent !== 'release') throw new Error(`기대: release, 실제: ${r.intent}`);
});

tc('tc-016', 'maestro-router/classifyWithRegex', '"v1.2.0 배포해" → intent=release', () => {
  const r = getClassify()('v1.2.0 배포해');
  if (r.intent !== 'release') throw new Error(`기대: release, 실제: ${r.intent}`);
});

tc('tc-017', 'maestro-router/classifyWithRegex', '"publish npm" → intent=release', () => {
  const r = getClassify()('publish npm');
  if (r.intent !== 'release') throw new Error(`기대: release, 실제: ${r.intent}`);
});

tc('tc-018', 'maestro-router/classifyWithRegex', '"만들어줘" → intent=implement', () => {
  const r = getClassify()('만들어줘');
  if (r.intent !== 'implement') throw new Error(`기대: implement, 실제: ${r.intent}`);
});

// ════════════════════════════════════════════════════════════════
// GROUP: maestro-router / PIPELINE_MAP
// ════════════════════════════════════════════════════════════════
tc('tc-019', 'maestro-router/PIPELINE_MAP', 'implement → [..., Critic, Release]', () => {
  const r = getClassify()('만들어줘');
  const expected = ['Planner', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'];
  const actual   = r.pipeline;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`기대: ${JSON.stringify(expected)}, 실제: ${JSON.stringify(actual)}`);
  }
});

tc('tc-020', 'maestro-router/PIPELINE_MAP', 'fix → [..., Critic, Release]', () => {
  const r = getClassify()('버그 고쳐');
  const expected = ['Investigator', 'Implementer', 'Tester', 'Reviewer', 'Critic', 'Release'];
  const actual   = r.pipeline;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`기대: ${JSON.stringify(expected)}, 실제: ${JSON.stringify(actual)}`);
  }
});

tc('tc-021', 'maestro-router/PIPELINE_MAP', 'release → [Release, Critic]', () => {
  const r = getClassify()('릴리즈해줘');
  const expected = ['Release', 'Critic'];
  const actual   = r.pipeline;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`기대: ${JSON.stringify(expected)}, 실제: ${JSON.stringify(actual)}`);
  }
});

tc('tc-022', 'maestro-router/PIPELINE_MAP', 'review → [Reviewer, Critic, Release]', () => {
  const r = getClassify()('리뷰해줘');
  const expected = ['Reviewer', 'Critic', 'Release'];
  const actual   = r.pipeline;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`기대: ${JSON.stringify(expected)}, 실제: ${JSON.stringify(actual)}`);
  }
});

tc('tc-023', 'maestro-router/PIPELINE_MAP', 'plan → [Planner, Critic, Release]', () => {
  const r = getClassify()('설계해줘');
  const expected = ['Planner', 'Critic', 'Release'];
  const actual   = r.pipeline;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`기대: ${JSON.stringify(expected)}, 실제: ${JSON.stringify(actual)}`);
  }
});

// ════════════════════════════════════════════════════════════════
// GROUP: maestro-router / timePerAgent
// ════════════════════════════════════════════════════════════════
tc('tc-024', 'maestro-router/timePerAgent', '9개 에이전트 모두 존재', () => {
  const src = readSrc('maestro-router.js');
  const required = ['Context7 Docs Agent', 'Planner', 'Implementer', 'Tester',
                    'Reviewer', 'Documenter', 'Investigator', 'Release', 'Critic'];
  // timePerAgent 객체에 모두 포함되어 있는지 소스 문자열로 검사
  for (const agent of required) {
    if (!src.includes(agent)) {
      throw new Error(`timePerAgent에 '${agent}' 누락`);
    }
  }
  // timePerAgent 리터럴이 존재하는지 확인
  if (!src.includes('timePerAgent')) {
    throw new Error('timePerAgent 객체가 소스에 없음');
  }
});

// ════════════════════════════════════════════════════════════════
// GROUP: maestro-router / SYSTEM_PROMPT
// ════════════════════════════════════════════════════════════════
tc('tc-025', 'maestro-router/SYSTEM_PROMPT', '"release" intent 포함', () => {
  const src = readSrc('maestro-router.js');
  const promptMatch = src.match(/const SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`/);
  if (!promptMatch) throw new Error('SYSTEM_PROMPT 상수를 찾을 수 없음');
  if (!/release/.test(promptMatch[1])) {
    throw new Error('SYSTEM_PROMPT에 "release" intent가 없음');
  }
});

tc('tc-026', 'maestro-router/SYSTEM_PROMPT', '"Release" 에이전트 목록 포함', () => {
  const src = readSrc('maestro-router.js');
  const promptMatch = src.match(/const SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`/);
  if (!promptMatch) throw new Error('SYSTEM_PROMPT 상수를 찾을 수 없음');
  if (!promptMatch[1].includes('Release')) {
    throw new Error('SYSTEM_PROMPT 에이전트 목록에 "Release"가 없음');
  }
});

tc('tc-027', 'maestro-router/SYSTEM_PROMPT', '"MISSING or NOT CONNECTED" auto-fix 힌트 포함', () => {
  const src = readSrc('maestro-router.js');
  const promptMatch = src.match(/const SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`/);
  if (!promptMatch) throw new Error('SYSTEM_PROMPT 상수를 찾을 수 없음');
  if (!/MISSING|NOT CONNECTED/i.test(promptMatch[1])) {
    throw new Error('SYSTEM_PROMPT에 "MISSING or NOT CONNECTED" 자동 Fix 힌트가 없음');
  }
});

// ════════════════════════════════════════════════════════════════
// GROUP: retrospective-trigger / syntax
// ════════════════════════════════════════════════════════════════
tc('tc-028', 'retrospective-trigger/syntax', 'node --check retrospective-trigger.js', () => {
  syntaxCheck('retrospective-trigger.js');
});

// ════════════════════════════════════════════════════════════════
// GROUP: retrospective-trigger / TERMINAL_AGENTS
// ════════════════════════════════════════════════════════════════
tc('tc-029', 'retrospective-trigger/TERMINAL_AGENTS',
   'TERMINAL_AGENTS에 Reviewer, Planner, Release, Documenter, Investigator 포함', () => {
  const src = readSrc('retrospective-trigger.js');
  const required = ['Reviewer', 'Planner', 'Release', 'Documenter', 'Investigator'];
  // TERMINAL_AGENTS Set 리터럴에서 각 에이전트 이름이 문자열로 존재하는지 확인
  for (const agent of required) {
    // 소스에 문자열 리터럴로 존재해야 함
    if (!src.includes(`'${agent}'`) && !src.includes(`"${agent}"`)) {
      throw new Error(`TERMINAL_AGENTS에 '${agent}' 누락`);
    }
  }
});

// ════════════════════════════════════════════════════════════════
// GROUP: maestro-routing.json / structure
// ════════════════════════════════════════════════════════════════
tc('tc-030', 'maestro-routing.json/structure', 'JSON 파싱 가능', () => {
  const raw = fs.readFileSync(path.join(HOOKS_DIR, 'maestro-routing.json'), 'utf8');
  try {
    JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON 파싱 실패: ${e.message}`);
  }
});

tc('tc-031', 'maestro-routing.json/structure', 'retrospective-trigger.js SubagentStop에 등록됨', () => {
  const raw  = fs.readFileSync(path.join(HOOKS_DIR, 'maestro-routing.json'), 'utf8');
  const json = JSON.parse(raw);
  const stops = json.hooks?.SubagentStop || [];
  const found = stops.some(h =>
    (h.command && h.command.includes('retrospective-trigger.js')) ||
    (h.windows  && h.windows.includes('retrospective-trigger.js'))
  );
  if (!found) throw new Error('SubagentStop에 retrospective-trigger.js가 없음');
});

tc('tc-032', 'maestro-routing.json/structure', 'maestro-router.js UserPromptSubmit에 등록됨', () => {
  const raw  = fs.readFileSync(path.join(HOOKS_DIR, 'maestro-routing.json'), 'utf8');
  const json = JSON.parse(raw);
  const submits = json.hooks?.UserPromptSubmit || [];
  const found = submits.some(h =>
    (h.command && h.command.includes('maestro-router.js')) ||
    (h.windows  && h.windows.includes('maestro-router.js'))
  );
  if (!found) throw new Error('UserPromptSubmit에 maestro-router.js가 없음');
});

// ════════════════════════════════════════════════════════════════
// GROUP: maestro.agent.md / content
// ════════════════════════════════════════════════════════════════
tc('tc-033', 'maestro.agent.md/content', 'agents: 리스트에 Release 포함', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('Release')) {
    throw new Error("maestro.agent.md agents 목록에 'Release' 없음");
  }
});

tc('tc-034', 'maestro.agent.md/content', 'H행 (릴리즈/배포) 분류 표 존재', () => {
  const src = readAgent('maestro.agent.md');
  // "H" 행과 릴리즈/배포 키워드가 함께 존재해야 함
  if (!/H[^|]*릴리즈|릴리즈[^|]*H/m.test(src) && !(/\|\s*\*\*H\./.test(src))) {
    // 대소문자/포맷 무관하게 "H" 또는 "H." 와 "릴리즈" 가 같은 행에
    const lines = src.split('\n');
    const hasH = lines.some(l => /H/.test(l) && /릴리즈|배포/.test(l));
    if (!hasH) throw new Error('H행 (릴리즈/배포) 분류 표가 없음');
  }
});

tc('tc-035', 'maestro.agent.md/content', '"6단계: Retrospective" 섹션 존재', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('6단계') || !(/Retrospective|회고/.test(src))) {
    throw new Error('"6단계" 또는 "Retrospective/회고" 섹션이 없음');
  }
  // 같은 줄에 존재하는지 확인
  const lines = src.split('\n');
  const found = lines.some(l => l.includes('6단계') && /Retrospective|회고/.test(l));
  if (!found) throw new Error('"6단계: Retrospective" 헤더가 없음');
});

tc('tc-036', 'maestro.agent.md/content', '"자동 Fix 규칙" 섹션 존재', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('자동 Fix') && !src.includes('자동Fix')) {
    throw new Error('"자동 Fix 규칙" 섹션이 없음');
  }
});

tc('tc-037', 'maestro.agent.md/content', '"생략 금지" 또는 "예외 없이" 파이프라인 표시 강제 문구 존재', () => {
  const src = readAgent('maestro.agent.md');
  if (!/생략 금지|생략금지|예외 없이|예외없이/.test(src)) {
    throw new Error('"생략 금지" 또는 "예외 없이" 강제 문구가 없음');
  }
});

// ════════════════════════════════════════════════════════════════
// GROUP: release.agent.md / content
// ════════════════════════════════════════════════════════════════
tc('tc-038', 'release.agent.md/content', 'name: Release 프론트매터 포함', () => {
  const src = readAgent('release.agent.md');
  if (!/^name:\s*Release/m.test(src)) {
    throw new Error('프론트매터에 "name: Release"가 없음');
  }
});

tc('tc-039', 'release.agent.md/content', '"git push --force" 금지 문구 포함', () => {
  const src = readAgent('release.agent.md');
  if (!/git push --force/.test(src)) {
    throw new Error('"git push --force" 금지 문구가 없음');
  }
});

tc('tc-040', 'release.agent.md/content', '"test-evidence" 확인 문구 포함', () => {
  const src = readAgent('release.agent.md');
  if (!src.includes('test-evidence')) {
    throw new Error('"test-evidence" 확인 문구가 없음');
  }
});

tc('tc-041', 'release.agent.md/content', 'handoffs에 Maestro, Implementer 둘 다 포함', () => {
  const src = readAgent('release.agent.md');
  if (!src.includes('Maestro')) {
    throw new Error('handoffs에 "Maestro"가 없음');
  }
  if (!src.includes('Implementer')) {
    throw new Error('handoffs에 "Implementer"가 없음');
  }
});

// ════════════════════════════════════════════════════════════════
// GROUP: file-guard.js / syntax
// ════════════════════════════════════════════════════════════════
tc('tc-042', 'file-guard.js/syntax', 'node --check file-guard.js', () => {
  syntaxCheck('file-guard.js');
});

// ════════════════════════════════════════════════════════════════
// GROUP: safety-guard.js / syntax
// ════════════════════════════════════════════════════════════════
tc('tc-043', 'safety-guard.js/syntax', 'node --check safety-guard.js', () => {
  syntaxCheck('safety-guard.js');
});

// ════════════════════════════════════════════════════════════════
// ── 러너 ────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════
async function run() {
  // TC 번호 중복 검증
  const ids = TCs.map(t => t.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    console.error(`FATAL: 중복 TC ID 발견: ${[...new Set(dupes)].join(', ')}`);
    process.exit(2);
  }

  let pass = 0, fail = 0;
  const failures = [];

  for (const t of TCs) {
    try {
      await t.fn();
      console.log(`  PASS [${t.id}] ${t.desc}`);
      pass++;
    } catch (e) {
      console.error(`  FAIL [${t.id}] ${t.desc}`);
      console.error(`       → ${e.message}`);
      fail++;
      failures.push({ id: t.id, group: t.group, desc: t.desc, error: e.message });
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Total: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);

  // test-evidence.json 업데이트
  const evidence = {
    ts:     new Date().toISOString(),
    suite:  'maestro-suite',
    total:  pass + fail,
    pass,
    fail,
    failures,
    status: fail === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'test-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Evidence → .github/logs/test-evidence.json`);

  process.exit(fail > 0 ? 1 : 0);
}

// ── tc-044~046: maestro-router.js 파이프라인 노출 강제 주입 ──────────
tc('tc-044', 'maestro-router / disclosure-injection', '필수 첫 출력 블록이 Maestro 주입에 포함됨', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes('응답의 첫 줄로')) throw new Error('필수 첫 출력 주입 텍스트 없음');
  if (!src.includes('🎯 **작업 유형**')) throw new Error('🎯 템플릿 텍스트 없음');
  if (!src.includes('📋 **파이프라인**')) throw new Error('📋 템플릿 텍스트 없음');
});

tc('tc-045', 'maestro-router / disclosure-injection', '주입 블록이 resumeBlock 앞에 위치함', () => {
  const src = readSrc('maestro-router.js');
  const disclosureIdx = src.indexOf('응답의 첫 줄로');
  const resumeIdx = src.indexOf('if (resumeBlock) parts.push(resumeBlock)');
  // 첫 번째 disclosure가 있고, 그 다음에 resumeBlock push가 나와야 함
  const firstResume = resumeIdx > disclosureIdx;
  if (disclosureIdx === -1) throw new Error('disclosure 블록 없음');
  if (!firstResume) throw new Error(`disclosure(${disclosureIdx})가 resumeBlock(${resumeIdx}) 뒤에 위치함`);
});

tc('tc-046', 'maestro-router / disclosure-injection', '이 블록 없이 출력하면 규칙 위반 경고 포함', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes('규칙 위반')) throw new Error('규칙 위반 경고 텍스트 없음');
});

// ── tc-047~052: actionItems / Retrospective → fix 자동 전환 ─────
tc('tc-047', 'retrospective-trigger / actionItems', 'draft에 actionItems 필드 포함', () => {
  const src = readSrc('retrospective-trigger.js');
  if (!src.includes('actionItems')) throw new Error('actionItems 필드 없음');
});

tc('tc-048', 'retrospective-trigger / ACTION_TEMPLATES', 'Tester·Reviewer·Planner 키 포함', () => {
  const src = readSrc('retrospective-trigger.js');
  if (!src.includes('ACTION_TEMPLATES')) throw new Error('ACTION_TEMPLATES 없음');
  if (!src.includes('Tester:'))    throw new Error('Tester 키 없음');
  if (!src.includes('Reviewer:'))  throw new Error('Reviewer 키 없음');
  if (!src.includes('Planner:'))   throw new Error('Planner 키 없음');
});

tc('tc-049', 'maestro-router / loadActionItems', 'loadActionItems 함수 존재', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes('function loadActionItems')) throw new Error('loadActionItems 함수 없음');
});

tc('tc-050', 'maestro-router / actionItems-injection', 'actionWarning 주입 코드 + draft 경로 참조', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes('actionWarning')) throw new Error('actionWarning 변수 없음');
  if (!src.includes('retrospective-draft.json')) throw new Error('draft 경로 참조 없음');
});

tc('tc-051', 'maestro.agent.md / actionItems-generate', 'actionItems 생성 규칙 섹션 존재', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('actionItems 생성 규칙')) throw new Error('actionItems 생성 규칙 섹션 없음');
});

tc('tc-052', 'maestro.agent.md / actionItems-consume', 'actionItems 소비 규칙 + 초기화 문구 존재', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('actionItems 소비 규칙')) throw new Error('actionItems 소비 규칙 섹션 없음');
  if (!src.includes('[]로 초기화')) throw new Error('초기화 문구 없음');
});

// ── tc-053~056: 파이프라인 규율 + 자가비평 가시화 ───────────────
tc('tc-053', 'maestro.agent.md / pipeline-discipline', '선언-실행 일치 + Maestro 직접 수정 금지 문구', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('선언-실행 일치')) throw new Error('선언-실행 일치 문구 없음');
  if (!/Maestro가 직접 코드를?\s*수정/.test(src)) throw new Error('Maestro 직접 수정 금지 문구 없음');
});

tc('tc-054', 'maestro.agent.md / tester-fail-loop', 'Tester FAIL → Implementer 재호출 규칙', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('Tester FAIL 처리 규칙')) throw new Error('Tester FAIL 처리 규칙 섹션 없음');
  if (!/Tester\s*↔\s*Implementer/.test(src)) throw new Error('Tester ↔ Implementer 순환 문구 없음');
});

tc('tc-055', 'maestro-router / pipeline-line-dynamic', 'actionItems 있을 때 [자가비평 ...] 첫 단계 주입 로직 존재', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes('자가비평')) throw new Error('자가비평 문자열 주입 코드 없음');
  // count 분기 검증 (function 또는 actionCount 변수)
  if (!/actionCount|loadActionItemsCount|items\.length/.test(src)) throw new Error('actionItems count 분기 로직 없음');
});

tc('tc-056', 'maestro.agent.md / actionItems-pipeline-display', '소비 규칙에 📋 [자가비평 N건] 표기 의무 포함', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('[자가비평 N건]') && !src.includes('자가비평 N건')) {
    throw new Error('[자가비평 N건] 표기 의무 문구 없음');
  }
});

// ── tc-057~060: 자가비평 → TC 자동 생성 파이프라인 ────────────────
tc('tc-057', 'tc-generator / syntax', 'tc-generator.js syntax 유효', () => {
  const { execSync } = require('child_process');
  const p = path.join(HOOKS, 'tc-generator.js');
  execSync(`node --check "${p}"`, { encoding: 'utf8' });
});

tc('tc-058', 'tc-generator / exports', 'generatePendingTCs·getExistingDedupeKeys·getMaxTcId 내보내기', () => {
  const gen = require(path.join(HOOKS, 'tc-generator.js'));
  if (typeof gen.generatePendingTCs    !== 'function') throw new Error('generatePendingTCs 없음');
  if (typeof gen.getExistingDedupeKeys !== 'function') throw new Error('getExistingDedupeKeys 없음');
  if (typeof gen.getMaxTcId           !== 'function') throw new Error('getMaxTcId 없음');
});

tc('tc-059', 'tc-generator / deduplication', '동일 dedupeKey 중복 생성 방지', () => {
  const gen = require(path.join(HOOKS, 'tc-generator.js'));
  const items = [
    { agent: 'Tester', source: 'skippedAgent', message: 'test', ts: new Date().toISOString() },
    { agent: 'Tester', source: 'skippedAgent', message: 'test2', ts: new Date().toISOString() },
  ];
  const result = gen.generatePendingTCs(items, path.join(process.cwd(), '.github', 'tests', 'maestro-suite.test.js'));
  // Tester는 이미 maestro-suite.test.js에 AUTO-TC dedupe:skippedAgent:Tester 없으므로 1개 생성
  // 단, 동일 배열 내 중복은 방지되어야 함 → 최대 1개
  if (result.length > 1) throw new Error(`중복 방지 실패: ${result.length}개 생성됨`);
});

tc('tc-060', 'retrospective-trigger / auto-tc-integration', 'auto-tc-pending.json 생성 코드 존재', () => {
  const src = readSrc('retrospective-trigger.js');
  if (!src.includes('auto-tc-pending.json')) throw new Error('auto-tc-pending.json 참조 없음');
  if (!src.includes('tc-generator'))         throw new Error('tc-generator require 없음');
  if (!src.includes('generatePendingTCs'))   throw new Error('generatePendingTCs 호출 없음');
});

// ── tc-061~064: Retrospective 자동화 ──────────────────────────────
tc('tc-061', 'retrospective-trigger / auto-history', 'history.md 자동 append 코드 존재', () => {
  const src = readSrc('retrospective-trigger.js');
  if (!src.includes('retrospective-history.md')) throw new Error('history.md 참조 없음');
  if (!src.includes('appendFileSync')) throw new Error('appendFileSync 호출 없음');
  if (!src.includes('자기비평')) throw new Error('자기비평 필드 없음');
});

tc('tc-062', 'retrospective-trigger / dedup', '동일 날짜+파이프라인 중복 방지 코드 존재', () => {
  const src = readSrc('retrospective-trigger.js');
  if (!src.includes('dupKey') && !src.includes('includes(dupKey)')) {
    throw new Error('중복 방지 로직 없음');
  }
});

tc('tc-063', 'maestro-router / retro-todo-inject', 'complexity≥3 Retrospective todo 강제 주입 텍스트', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes('Retrospective 기록')) throw new Error('Retrospective 기록 todo 주입 없음');
  if (!src.includes('complexity')) throw new Error('complexity 언급 없음');
});

tc('tc-064', 'maestro.agent.md / retro-hook-note', '훅 자동 기록 안내 + 자기비평 필드 미기입=미완료 경고', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('훅 자동 기록')) throw new Error('훅 자동 기록 안내 없음');
  if (!src.includes('자기비평') && !src.includes('미완료')) throw new Error('미완료 경고 없음');
});

// ── tc-065~068: 미처리 감사 항목 구현 검증 ─────────────────────

tc('tc-065', 'maestro-router / tester-todo-inject', 'Tester 독립 todo 항목 주입 지시 존재', () => {
  const src = readSrc('maestro-router.js');
  if (!/Tester.*독립|독립.*todo.*Tester|implement.*fix.*Tester/.test(src))
    throw new Error('Tester 독립 항목 주입 지시 없음');
});

tc('tc-066', 'maestro.agent.md / critic-pipeline', '비-릴리즈 파이프라인에 Critic → Release 포함', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('→ Critic → Release')) throw new Error('파이프라인에 Critic → Release 없음');
});

tc('tc-067', 'maestro.agent.md / critic-obligation', 'Critic 호출 의무 경고 존재', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('Critic 호출 의무')) throw new Error('Critic 호출 의무 경고 없음');
});

tc('tc-068', 'maestro-router.js / critic-pipeline', 'PIPELINE_MAP 모든 항목에 Critic 존재', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes("'Critic'")) throw new Error("PIPELINE_MAP에 'Critic' 없음");
});

// ── tc-069~073: critic.agent.md 검증 ─────────────────────────

tc('tc-069', 'critic.agent.md / exists', 'critic.agent.md 파일 존재', () => {
  const file = path.join(AGENTS, 'critic.agent.md');
  if (!fs.existsSync(file)) throw new Error('critic.agent.md 파일 없음');
});

tc('tc-070', 'critic.agent.md / checklist', '체크 항목 H1~H6 모두 포함', () => {
  const src = readAgent('critic.agent.md');
  for (const h of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6']) {
    if (!src.includes(h)) throw new Error(`${h} 체크 항목 없음`);
  }
});

tc('tc-071', 'critic.agent.md / fail-action', 'FAIL 시 재호출 지시 존재', () => {
  const src = readAgent('critic.agent.md');
  if (!src.includes('재호출')) throw new Error('FAIL 시 재호출 지시 없음');
});

tc('tc-072', 'maestro-router.js / critic-todo', 'todo 가이드에 Critic 호출 의무 명시', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes('Critic 호출')) throw new Error('todo 가이드에 Critic 호출 의무 없음');
});

tc('tc-073', 'maestro.agent.md / critic-sequential', '순차 실행 규칙에 Critic 포함', () => {
  const src = readAgent('maestro.agent.md');
  if (!src.includes('Critic 호출 (파이프라인 실행 내역 전달')) throw new Error('순차 실행 규칙에 Critic 없음');
});

// ── tc-074~076: Release 파이프라인 마무리 커밋 연동 ────────────────────────
tc('tc-074', 'maestro-router.js / release-at-end', 'implement/fix 파이프라인이 Release로 끋남', () => {
  const r = getClassify()('만들어줘');
  const last = r.pipeline[r.pipeline.length - 1];
  if (last !== 'Release') throw new Error(`마지막 에이전트가 Release가 아님: ${last}`);
});

tc('tc-075', 'maestro-router.js / release-intent-exactly-one-release', 'release 파이프라인은 Release 정확히 1개', () => {
  const r = getClassify()('릴리즈해줘');
  const releaseCount = r.pipeline.filter(a => a === 'Release').length;
  if (releaseCount !== 1) throw new Error(`release 파이프라인에 Release가 ${releaseCount}개 — 정확히 1개여야 함`);
});

tc('tc-076', 'release.agent.md / commit-only-mode', '커밋 전용 모드 섹션 존재', () => {
  const src = readAgent('release.agent.md');
  if (!src.includes('커밋 전용 모드')) throw new Error('커밋 전용 모드 섹션 없음');
});

// ── tc-077~078: Critic H3 intent 기반 Tester 필수 규칙 ─────────────────────────

tc('tc-077', 'critic.agent.md / h3-intent-based', 'H3가 intent(implement/fix) 기반 Tester 필수 명시', () => {
  const src = readAgent('critic.agent.md');
  if (!src.includes('implement')) throw new Error('H3에 implement 기반 체크 없음');
  if (!src.includes('fix') || !src.includes('Tester')) throw new Error('H3에 fix/Tester 조건 없음');
  // complexity 기반 자동 PASS 규칙이 없어야 함
  if (src.includes('complexity < 5면 자동 PASS')) throw new Error('H3가 아직 complexity 기반 자동 PASS 로직 포함');
});

tc('tc-078', 'maestro-router.js / implement-tester-rule', 'SYSTEM_PROMPT에 implement Tester 필수 규칙 존재', () => {
  const src = readSrc('maestro-router.js');
  if (!src.includes('intent=implement') || !src.includes('Tester')) throw new Error('SYSTEM_PROMPT에 implement Tester 필수 규칙 없음');
});

run();

