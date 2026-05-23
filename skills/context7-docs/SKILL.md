---
name: context7-docs
description: Context7 MCP를 사용해 라이브러리·프레임워크 공식 문서를 조회하고 최신 API 기반 코드를 생성한다. "Next.js 설정해줘", "Prisma 쿼리 작성해줘" 같은 요청에 사용한다.
argument-hint: '[라이브러리명] [원하는 기능]'
---

# Context7 공식 문서 조회 스킬

라이브러리/프레임워크 코드를 작성하기 전에 **반드시** 공식 최신 문서를 조회한다.

## 사용 방법

```
/context7-docs React useCallback 사용법
/context7-docs Next.js 14 App Router 미들웨어
/context7-docs Prisma 트랜잭션 처리
```

## 조회 절차

1. `context7/resolve-library-id` 도구로 라이브러리 ID 조회
2. `context7/query-docs` 도구로 해당 기능 문서 스니펫 가져오기
3. 문서에서 확인한 API·옵션·파라미터로 코드 작성

## 적용 범위

- 패키지 설치 / 초기 설정
- API 메서드 · 옵션 · 파라미터
- 버전 마이그레이션
- 프레임워크 boilerplate 생성

## 중요 규칙

- 학습 데이터(training data)로 API를 **추측하지 않는다**
- 문서에 없는 옵션은 사용하지 않는다
- 사용자가 버전을 지정하면 해당 버전의 문서를 조회한다
