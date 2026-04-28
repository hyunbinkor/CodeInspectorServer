# Known Issues

미해결 이슈 목록. 각 항목은 향후 PR로 해결 예정. PR 머지 시 해당 항목 제거.

## 🟡 High — 기능적 결함

### H2. Header/Footer 청크 검사 제외

**위치**: `src/core/checker/codeChecker.js` (청킹 루프 내 `chunk.type === 'header' | 'footer'` 분기)

import 블록(header)과 잔여 코드(footer)를 `continue`로 스킵. deprecated API import, wildcard import 금지 같은 규칙은 파일 검사에서도 영구 미탐지.

**해결 방향**: header/footer도 `pure_regex` 규칙은 검사. LLM 검증은 스킵.

### H3. 청크 순차 처리 (성능)

**위치**: `src/core/checker/codeChecker.js` `checkCodeChunked` for 루프

청크가 20개면 LLM 호출 시간 × 20. `p-limit(3~5)`로 병렬화 시 2~5배 빠름.

### H4. 불필요한 `_sleep(100)`

**위치**: `src/core/checker/codeChecker.js` `verifyWithLLM` 루프

각 LLM 검증 사이 100ms 대기. 50개 규칙 = 5초 추가 지연. vLLM rate limit 없으면 제거.

## 🟢 Medium — 코드 정리

### M4. `checkCode` 일반 모드와 `checkCodeDirect` 로직 중복

**위치**: `src/core/checker/codeChecker.js`

전자가 후자를 호출하도록 통합 가능.

## 인프라 미정 항목

- LICENSE — 사내 표준 확정 후 추가
- CI/CD (`.gitlab-ci.yml`) — 환경 제공 후 도입
- 요청 추적 ID — 플러그인 변경 비용 고려해 보류

## 분류 표

| 코드 | 영향 | 작업량 |
|---|---|---|
| H2 | import 규칙 작동 | 하 |
| H3 | 청킹 검사 속도 | 중 |
| H4 | 검사 속도 | 하 |
| M4 | 유지보수성 | 하 |
