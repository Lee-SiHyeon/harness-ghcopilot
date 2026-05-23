---
name: TypeScript Standards
description: TypeScript/TSX 파일 작성 시 적용되는 코딩 컨벤션
applyTo: '**/*.ts,**/*.tsx'
---

## TypeScript 코딩 컨벤션

### 타입 시스템
- `any` 사용 금지. `unknown`을 사용하고 타입 가드로 좁힌다.
- 함수 반환 타입을 명시한다. 단, 추론이 명확한 경우 생략 가능.
- `interface`는 확장 가능한 객체 타입에, `type`은 유니온/인터섹션에 사용한다.
- `as` 타입 단언은 피한다. 대신 타입 가드 또는 `satisfies`를 사용한다.

### 함수
- 순수 함수를 우선한다.
- 콜백보다 `async/await`를 사용한다.
- `null` 대신 `undefined`를 반환한다.

### 임포트
- 사용하지 않는 임포트를 제거한다.
- 타입만 임포트할 때는 `import type`을 사용한다.
- 배럴(index.ts) 익스포트를 과도하게 사용하지 않는다.

### 네이밍
- 컴포넌트/클래스: `PascalCase`
- 함수/변수: `camelCase`
- 상수: `SCREAMING_SNAKE_CASE`
- 파일명: `kebab-case.ts`

### 에러 처리
- `try/catch`에서 `catch (e: unknown)`을 사용하고 `instanceof Error`로 확인한다.
- Promise rejection을 항상 처리한다.
