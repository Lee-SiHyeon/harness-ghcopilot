---
name: comprehensive-docs
description: 기술 스택·프레임워크·API의 모든 기능을 실전 예제와 함께 체계적으로 문서화하는 스킬. Hook, API, CLI, 설정 파일 등 모든 옵션을 빠짐없이 정리하고 실제 동작하는 코드 예제를 생성합니다.
---

# Comprehensive Documentation Generator

API, 프레임워크, 설정 파일의 모든 기능을 **빠짐없이** 정리하고 **실제 동작하는 예제**를 생성하는 문서화 스킬입니다.

## 이 스킬을 사용하는 경우

- 새로운 API/프레임워크를 프로젝트에 도입할 때 전체 기능 파악
- 설정 파일(`.json`, `.yaml`, frontmatter)의 모든 옵션 문서화
- 팀원들을 위한 실전 예제 생성
- 레거시 코드의 기능 목록 역공학
- "이 기술의 모든 기능이 뭐야?"라는 질문에 답변

## 작업 프로세스

### 1단계: 기능 목록 완전 파악

**목표**: 빠뜨린 기능이 없도록 전체 스펙 확인

**방법**:
1. **공식 문서 조회** (Context7 MCP 활용)
   ```
   @context7-docs [라이브러리명] all features
   ```

2. **타입 정의 확인** (TypeScript/Python)
   ```typescript
   // 인터페이스에서 모든 필드 추출
   interface HookConfig {
     type: string;
     command: string;
     windows?: string;
     timeout?: number;
   }
   ```

3. **기존 코드 검색**
   ```bash
   grep -r "hookEventName" --include="*.ts" --include="*.js"
   ```

4. **체크리스트 작성**
   ```
   ✅ SessionStart
   ✅ UserPromptSubmit
   ✅ PreToolUse
   ✅ PostToolUse
   ✅ PreCompact
   ✅ SubagentStart
   ✅ SubagentStop
   ✅ Stop
   ```

---

### 2단계: 기능별 예제 설계

**원칙**:
- **실제 동작하는 코드** (복붙하면 바로 실행 가능)
- **주석으로 상세 설명** (용도, 환경변수, 출력 형식)
- **에러 처리 포함** (실패해도 무시하는 경우 명시)

**예제 구조**:
```javascript
#!/usr/bin/env node
/**
 * [기능명] 예제
 * 
 * 용도: [한 줄 설명]
 * 
 * 환경변수:
 * - VAR_NAME: 설명
 */

// ═══════════════════════════════════════════════════════════════════
// 1. [첫 번째 기능]
// ═══════════════════════════════════════════════════════════════════
const example1 = () => {
  // 구현
};

// ═══════════════════════════════════════════════════════════════════
// 2. [두 번째 기능]
// ═══════════════════════════════════════════════════════════════════
const example2 = () => {
  // 구현
};

// 최종 출력
console.log(JSON.stringify({ result: 'success' }));
```

---

### 3단계: 파일 구조 설계

**원칙**:
- 설정 파일과 스크립트를 **쌍으로 관리**
- 번호 prefix로 **순서 명확히**
- `examples/` 폴더로 **실제 사용과 분리**

**예시 구조**:
```
.github/hooks/
├── quality.json                     ← 실제 사용 중
├── _OPTIONS.md                      ← 전체 옵션 가이드
└── examples/                        ← 예제 모음
    ├── README.md                    ← 종합 가이드
    ├── 1-session-start.json
    ├── 2-user-prompt-submit.json
    ├── ...
    └── scripts/
        ├── session-start.js
        ├── user-prompt-submit.js
        └── ...
```

---

### 4단계: 종합 가이드 작성 (README)

**필수 포함 내용**:

1. **기능 비교 테이블**
   ```markdown
   | 기능 | 타이밍 | 용도 |
   |---|---|---|
   | SessionStart | 세션 시작 | 환경 정보 주입 |
   ```

2. **빠른 시작 가이드**
   ```bash
   # 전체 활성화
   cp examples/*.json ./
   ```

3. **실전 조합 예시**
   ```markdown
   ### 보안 강화
   - PreToolUse (파일 접근 차단)
   - UserPromptSubmit (위험 프롬프트 차단)
   ```

4. **커스터마이징 방법**
   ```javascript
   // scripts/pre-tool-use.js 수정
   const sensitivePatterns = [
     /\.env$/,
     /your-custom-pattern/  // 여기 추가
   ];
   ```

5. **트러블슈팅**
   ```markdown
   ## 작동하지 않으면
   1. 설정 확인
   2. 권한 확인
   3. 직접 실행해보기
   ```

---

### 5단계: 옵션 문서화 (_OPTIONS.md)

**구조**:
1. **개요** (한 줄 설명)
2. **전체 옵션 테이블**
3. **옵션 상세 설명**
4. **전체 예시 템플릿**
5. **실제 사용 예시**
6. **주의사항**

**예시**:
```markdown
# [기능명] 설정 옵션 완전 가이드

## 지원되는 옵션

| 옵션 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| type | string | ✅ | - | 항상 "command" |
| command | string | ✅ | - | 실행 명령어 |
| timeout | number | ❌ | 30 | 타임아웃(초) |

## 출력 형식

### 기본 응답
\`\`\`json
{"continue": true}
\`\`\`

### 추가 컨텍스트 주입
\`\`\`json
{
  "continue": true,
  "hookSpecificOutput": {...}
}
\`\`\`
```

---

## 실전 적용 예시

### 케이스 1: GitHub Copilot Hooks (방금 작업)

**요구사항**: 8가지 Hook 이벤트의 모든 기능 정리

**산출물**:
```
.github/hooks/examples/
├── README.md                        ← 종합 가이드
├── _OPTIONS.md                      ← 옵션 문서
├── 1-session-start.json             ← 7개 설정 파일
├── 2-user-prompt-submit.json
├── ...
└── scripts/
    ├── session-start.js             ← 8개 실행 스크립트
    ├── user-prompt-submit.js
    └── ...
```

**특징**:
- ✅ 8가지 이벤트 모두 커버
- ✅ 각 이벤트마다 실제 동작하는 Node.js 스크립트
- ✅ 보안 차단, 자동 포맷팅, 메트릭 수집 등 실전 기능
- ✅ 조합 가이드 (보안/자동화/메트릭)

---

### 케이스 2: REST API 클라이언트 문서화

**요구사항**: API 엔드포인트 전체 + 사용 예제

**작업**:
```typescript
// 1단계: 모든 엔드포인트 파악
GET  /users
POST /users
GET  /users/:id
PUT  /users/:id
DELETE /users/:id

// 2단계: 예제 생성
// examples/
// ├── 1-list-users.ts
// ├── 2-create-user.ts
// ├── 3-get-user.ts
// ├── 4-update-user.ts
// ├── 5-delete-user.ts
// └── README.md
```

---

### 케이스 3: CLI 도구 문서화

**요구사항**: `git` 명령어 체계적 정리

**작업**:
```bash
# 1단계: 명령어 분류
git clone    # 1. 저장소 관리
git init
git add      # 2. 스테이징
git commit   # 3. 커밋
git push     # 4. 원격 동기화
git pull

# 2단계: 카테고리별 예제
examples/
├── 1-repository-management.sh
├── 2-staging-and-committing.sh
├── 3-branching.sh
├── 4-remote-sync.sh
└── README.md
```

---

## 품질 체크리스트

문서화 작업 후 다음을 확인:

- [ ] **완전성**: 모든 기능/옵션을 빠짐없이 포함했는가?
- [ ] **실행 가능성**: 예제 코드를 복붙하면 바로 실행되는가?
- [ ] **명확성**: 각 예제의 용도가 주석으로 명확한가?
- [ ] **구조화**: 파일 이름/폴더 구조가 직관적인가?
- [ ] **조합 가이드**: 여러 기능을 함께 쓰는 법이 설명되어 있는가?
- [ ] **트러블슈팅**: 안 될 때 해결 방법이 있는가?
- [ ] **커스터마이징**: 수정 포인트가 명확히 표시되어 있는가?

---

## 도구 활용

### Context7 MCP로 최신 문서 조회
```
1. resolve-library-id로 라이브러리 ID 확인
2. query-docs로 "all configuration options" 조회
3. query-docs로 "advanced examples" 조회
```

### 코드 검색으로 실제 사용 패턴 찾기
```bash
# 특정 API 호출 패턴
grep -r "hookSpecificOutput" --include="*.ts"

# 설정 파일 패턴
find . -name "*.json" -exec grep -l "hooks" {} \;
```

### 타입 정의에서 옵션 추출
```typescript
// TypeScript 인터페이스 → 옵션 목록
interface Config {
  name: string;        // 필수
  description?: string; // 선택
  timeout?: number;     // 선택, 기본값 30
}
```

---

## 템플릿: README 구조

```markdown
# [기능명] 예제 모음

[한 줄 설명]

## 📁 파일 구조
[트리 다이어그램]

## 🚀 사용 방법
### 1. 전체 활성화
### 2. 개별 테스트
### 3. 설정 확인

## 📚 각 기능 상세 설명
### 1️⃣ [기능 1]
### 2️⃣ [기능 2]
...

## 🎯 실전 조합 예시
### [조합 1]
### [조합 2]

## 🔧 커스터마이징
[수정 포인트]

## 🐛 디버깅
[트러블슈팅]

## 📖 참고 문서
[링크]
```

---

## 사용 예시

### 호출 방법 1: Prompt로 빠르게
```
/document-feature

대상: Prisma Client API
```

### 호출 방법 2: Documenter Agent 직접 호출
```
@Documenter

GitHub Copilot Hooks의 모든 기능을 실전 예제와 함께 정리해줘.
```

### 호출 방법 3: 자동화 스크립트
```bash
# 파일 구조만 먼저 생성
node .github/scripts/create-docs-structure.js \
  --target "docs/hooks/examples" \
  --features "SessionStart,PreToolUse,PostToolUse" \
  --extension "json" \
  --script-extension "js"

# 그 다음 Documenter Agent가 내용 채우기
```

### 호출 방법 4: 다른 Agent에서 참조
```yaml
---
name: API Documentation Agent
tools: [read, edit, search, 'context7/*']
---

새로운 API/프레임워크를 문서화할 때는 comprehensive-docs 스킬의
5단계 프로세스를 따른다:
1. 기능 목록 완전 파악
2. 기능별 예제 설계
3. 파일 구조 설계
4. 종합 가이드 작성
5. 옵션 문서화
```

---

## 이 스킬의 강점

1. **빠짐없는 커버리지**: 전체 스펙을 체계적으로 파악
2. **실행 가능한 예제**: 복붙하면 바로 동작하는 코드
3. **재사용 가능한 구조**: 다른 프로젝트에 복사해서 사용
4. **팀원 온보딩**: 새 팀원이 보고 바로 이해 가능
5. **미래의 나를 위한 기록**: 6개월 후에도 이해 가능

---

## 관련 리소스

### Agents
- **Documenter** (`.github/agents/documenter.agent.md`) - 이 스킬을 자동 실행하는 전문 agent
- **Context7 Docs Agent** - 최신 공식 문서 조회

### Prompts
- **/document-feature** (`.github/prompts/document-feature.prompt.md`) - 빠른 호출용 슬래시 커맨드

### Scripts
- **create-docs-structure.js** (`.github/scripts/create-docs-structure.js`) - 파일 구조 자동 생성

### Other Skills
- `context7-docs`: 공식 문서 조회
- `agent-customization`: VS Code Agent 커스터마이제이션

---

## 버전 히스토리

- v1.1: 자동화 추가 (Documenter Agent, 스크립트, Prompt)
- v1.0: 초기 버전 (GitHub Copilot Hooks 예제 작업 기반)
