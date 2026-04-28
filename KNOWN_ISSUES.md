# Known Issues

미해결 이슈 목록. 각 항목은 향후 PR로 해결 예정. PR 머지 시 해당 항목 제거.

## 🔴 Critical — 검사 정확도/안정성에 직접 영향

### C2. `truncateCode` 후 라인 번호 어긋남

**위치**: `src/core/checker/codeChecker.js:783-786`

`truncateCode`가 "// ... (N줄 생략) ..." 주석을 삽입하지만 `addLineNumbers(truncatedCode, 1)`는 1부터 연속 번호를 붙인다. LLM이 리포트한 line이 원본과 어긋난다. 80KB 초과 코드 (선택 검사 ≥6000줄 시) 결과 라인이 전부 부정확.

**해결 방향**: `addLineNumbers`를 truncation **이전**에 적용하고 `truncateCode`가 prefix를 보존하도록 수정.

### C3. `filteringStats` race condition

**위치**: `src/core/checker/codeChecker.js:71-77, 169` 외 11곳

`filteringStats`가 싱글톤 CodeChecker 인스턴스 속성. 동시 검사 요청 시 서로 덮어씀. 응답의 `stats.llmCalls`가 다른 요청 값일 수 있음.

**해결 방향**: 지역 변수로 이동, 결과에 포함해서 반환.

## 🟡 High — 기능적 결함

### H2. Header/Footer 청크 검사 제외

**위치**: `src/core/checker/codeChecker.js:276-280`

import 블록(header)과 잔여 코드(footer)를 `continue`로 스킵. deprecated API import, wildcard import 금지 같은 규칙은 파일 검사에서도 영구 미탐지.

**해결 방향**: header/footer도 `pure_regex` 규칙은 검사. LLM 검증은 스킵.

### H3. 청크 순차 처리 (성능)

**위치**: `src/core/checker/codeChecker.js:273-325`

청크가 20개면 LLM 호출 시간 × 20. `p-limit(3~5)`로 병렬화 시 2~5배 빠름.

### H4. 불필요한 `_sleep(100)`

**위치**: `src/core/checker/codeChecker.js:843`

각 LLM 검증 사이 100ms 대기. 50개 규칙 = 5초 추가 지연. vLLM rate limit 없으면 제거.

### H5. dedup 키 불일치

**위치**: `codeChecker.deduplicateViolations` vs `chunkResultMerger.deduplicateIssues`

전자: `${line}-${ruleId}-${column}`. 후자: `${ruleId}-${line}-${desc 50자}`. description이 한두 글자만 달라도 중복 안 잡힘.

**해결 방향**: 키 통일.

## 🟢 Medium — 코드 정리

### M1. `astAnalysis.detectedIssues` 데드 코드

**위치**: `src/core/checker/codeChecker.js:883, 936`

`javaAstParser`에 해당 필드 없음. 항상 falsy → LLM 프롬프트에 안 들어감.

### M2. `chunk.codeWithHeader`, `chunk.headerLineCount` 레거시

**위치**: `src/core/chunker/methodChunker.js`

생성하지만 어디서도 사용 안 함. `chunkResultMerger`도 주석에 "역산 로직 제거" 명시.

### M3. `buildGitHubAnnotations` 줄바꿈 미처리

**위치**: `src/services/checkService.js:190`

LLM 응답 description에 줄바꿈이 있으면 GitHub Actions가 깨짐. `%0A` 이스케이프 필요.

### M4. `checkCode` 일반 모드와 `checkCodeDirect` 로직 중복

**위치**: `src/core/checker/codeChecker.js:163-245` vs `:368-416`

전자가 후자를 호출하도록 통합 가능.

## 인프라 미정 항목

- LICENSE — 사내 표준 확정 후 추가
- CI/CD (`.gitlab-ci.yml`) — 환경 제공 후 도입
- 단위 테스트 — Vitest 도입 PR 별도 진행 예정
- ESLint/EditorConfig — 별도 PR 예정
- 헬스체크 분리 (`/livez`, `/readyz`) — 별도 PR 예정
- 요청 추적 ID — 플러그인 변경 비용 고려해 보류

## 분류 표

| 코드 | 영향 | 작업량 |
|---|---|---|
| C2 | 선택 검사 6000줄 라인 정확도 | 중~상 |
| C3 | 동시 요청 안정성 | 하 |
| H2 | import 규칙 작동 | 하 |
| H3 | 청킹 검사 속도 | 중 |
| H4 | 검사 속도 | 하 |
| H5 | 결과 깨끗함 | 하 |
| M* | 유지보수성 | 하 |
