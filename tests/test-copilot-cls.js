'use strict';
const { classifyWithCopilot, getLlmErrorReason } = require('../hooks/scripts/router/classifier');

const tests = [
  { t: '훅 점검해 왜자꾸 놓치는거야', expect: /fix|investigate/ },
  { t: '새 기능 만들어줘 로깅 추가해', expect: /implement/ },
  { t: '이 코드 리뷰해줘', expect: /review/ },
  { t: 'scout으로 개선점 찾아와', expect: /scout/ },
  { t: '고쳐줘 버그있어', expect: /fix/ },
];

(async () => {
  let pass = 0, fail = 0;
  for (const { t, expect } of tests) {
    const start = Date.now();
    const r = await classifyWithCopilot(t);
    const ms = Date.now() - start;
    const ok = r && expect.test(r.intent);
    console.log(`${ok ? '✅' : '❌'} [${ms}ms] intent=${r?.intent || 'null'} pipeline=${(r?.pipeline || []).slice(0, 3).join('→')} | ${t}`);
    if (!ok) console.log('  reason:', getLlmErrorReason());
    ok ? pass++ : fail++;
  }
  console.log(`\nResults: ${pass}/${pass + fail} PASS`);
  process.exit(fail > 0 ? 1 : 0);
})();
