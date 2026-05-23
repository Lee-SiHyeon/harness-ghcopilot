---
name: Python Standards
description: Python 파일 작성 시 적용되는 코딩 컨벤션
applyTo: '**/*.py'
---

## Python 코딩 컨벤션

### 스타일
- PEP 8을 따른다.
- 들여쓰기: 4 스페이스.
- 줄 길이: 최대 88자 (black 기본값).

### 타입 힌트
- 모든 함수 시그니처에 타입 힌트를 추가한다.
- `Optional[X]` 대신 `X | None` (Python 3.10+).
- `Dict`, `List`, `Tuple` 대신 `dict`, `list`, `tuple` (Python 3.9+).

### 함수
- 퍼블릭 함수에는 docstring을 작성한다.
- 함수는 단일 책임을 갖는다.
- 사이드 이펙트가 없는 순수 함수를 선호한다.

### 임포트
- 표준 라이브러리 → 서드파티 → 로컬 순서로 그룹화한다.
- `from module import *` 사용 금지.

### 에러 처리
- 넓은 `except Exception`보다 구체적인 예외를 잡는다.
- `except` 블록에서 에러를 무시하지 않는다.

### 네이밍
- 클래스: `PascalCase`
- 함수/변수: `snake_case`
- 상수: `SCREAMING_SNAKE_CASE`
- 모듈: `snake_case.py`
