---
name: document-feature
description: API, 설정 파일, CLI 도구의 모든 기능을 빠짐없이 문서화합니다. Context7로 최신 정보를 조회하고 실행 가능한 예제를 생성합니다.
agent: Documenter
argument-hint: '[문서화할 대상] (예: Prisma Client, Next.js Config, Git Commands)'
---

# 기능 완전 문서화

다음 대상의 **모든 기능을 빠짐없이 문서화**하고 **실행 가능한 예제**를 생성해줘:

**대상**: ${input:target:문서화할 대상 (라이브러리, API, 설정 파일)}

## 요구사항

### 1. Context7로 최신 정보 조회 (필수!)
- 모든 설정 옵션
- 모든 API 메서드
- 버전별 차이점 (있는 경우)

### 2. 완전한 기능 목록
- 누락된 기능이 없도록 체계적으로 파악
- 체크리스트 작성

### 3. 실행 가능한 예제
- 복붙하면 즉시 실행되는 코드
- 상세한 주석 (용도, 환경변수, 출력)
- 에러 처리 포함

### 4. 파일 구조
```
[target]/
├── _OPTIONS.md              ← 전체 옵션 가이드
└── examples/
    ├── README.md            ← 종합 가이드
    ├── 1-feature-a.ext
    ├── 2-feature-b.ext
    └── scripts/
        ├── feature-a.js
        └── feature-b.js
```

### 5. 종합 가이드
- 사용 방법 (전체/개별)
- 실전 조합 예시
- 커스터마이징 가이드
- 트러블슈팅

## 작업 프로세스

**comprehensive-docs 스킬**을 따라서:

1. ✅ Phase 1: Context7로 기능 목록 완전 파악
2. ✅ Phase 2: 기능별 예제 설계 및 생성
3. ✅ Phase 3: 자동화 스크립트로 파일 구조 생성
4. ✅ Phase 4: 종합 가이드 (README) 작성
5. ✅ Phase 5: 옵션 문서 (_OPTIONS.md) 작성

## 자동화 도구

필요하면 다음 스크립트를 활용해:

```bash
node .github/scripts/create-docs-structure.js \
  --target "docs/[대상]/examples" \
  --features "FeatureA,FeatureB,FeatureC" \
  --extension "json" \
  --script-extension "js"
```

## 품질 체크리스트

완료 후 검증:

- [ ] Context7로 최신 문서 조회했는가?
- [ ] 모든 옵션/기능을 커버했는가?
- [ ] 예제를 복붙하면 바로 실행되는가?
- [ ] 주석으로 충분히 설명했는가?
- [ ] 조합 가이드가 있는가?
- [ ] 트러블슈팅 섹션이 있는가?

---

**출력 형식**:

```
✅ 문서화 완료!

📂 생성 파일:
- _OPTIONS.md
- examples/README.md
- examples/1-feature.ext (× N개)

🔗 바로 사용:
cp examples/* ./
```
