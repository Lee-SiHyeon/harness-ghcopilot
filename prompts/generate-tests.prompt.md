---
# ─── 기본 메타데이터 ────────────────────────────────────────────────
name: generate-tests
description: 선택한 코드에 대한 단위 테스트를 생성한다
argument-hint: '[테스트할 파일 경로]'

# ─── Agent 및 도구 설정 ─────────────────────────────────────────────
agent: implementer

# Agent의 기본 도구를 제한 — 테스트 생성에 필요한 도구만 허용
tools: [read, edit, search, 'context7/*']

# ─── 기타 사용 가능 옵션 (주석 처리) ──────────────────────────────────
# model: Claude Sonnet 4.5 (copilot)  # 특정 모델 강제
# user-invocable: false               # 슬래시 커맨드에서 숨김
# agents: ['Planner', 'Reviewer']     # Subagent 제한
# handoffs:                           # 테스트 생성 후 다음 단계
#   - label: Run Tests - 테스트 실행
#     prompt: 방금 생성한 테스트를 실행해줘
#     send: true
---

# 단위 테스트 생성

다음 파일에 대한 포괄적인 단위 테스트를 작성해줘: ${input:file:테스트할 파일 경로}

## 테스트 작성 지침

1. **Context7 확인**: 사용 중인 테스트 프레임워크(Jest, Vitest, pytest 등)의 최신 API 조회
2. **커버리지 목표**: 모든 공개 함수/메서드 테스트
3. **테스트 케이스**:
   - Happy path (정상 케이스)
   - Edge cases (경계값, 빈 입력, null/undefined)
   - Error cases (예외 발생 시나리오)
4. **패턴**:
   - Arrange / Act / Assert 구조
   - 각 테스트는 독립적
   - Mock은 필요한 경우에만 사용

## 파일 위치

테스트 파일은 소스 파일 옆에 `.test.ts` / `.test.py` 등으로 생성한다.
