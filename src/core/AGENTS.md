# src/core/ — 검사 엔진 핵심

## 데이터 흐름 (`checkCode` 진입 이후)

```
checkCode(code, fileName, options)
├─ [분기] checkMode 또는 줄 수로 chunking 결정
│
├─ [일반 모드] 단일 경로
│   extractTags → parseJavaCode → findByTags → preFilterRules → verifyWithLLM → deduplicate → buildReport
│
└─ [청킹 모드]
    methodChunker.chunk → 각 청크별 checkCodeDirect (루프) → chunkResultMerger.merge → toSARIF/toJSON
```

## 유지보수 시 주의사항

### checker/codeChecker.js

- **`checkCode`와 `checkCodeDirect`는 로직이 거의 중복**. 수정 시 두 군데 다 손보기 (또는 통합 리팩토링).
- `filteringStats`는 인스턴스 속성 — **동시 요청 race condition** 존재 (C3 이슈). 수정할 거면 지역 변수로 옮길 것.
- `preFilterRules`의 `default` 분기(알 수 없는 checkType)는 `llm_contextual`로 폴백. 새 checkType 추가 시 `validCheckTypes` 배열도 업데이트.
- LLM 응답 파싱은 `llmClient.cleanAndExtractJSON(response)` 사용. JSON 여러 후보 중 최선 선택 로직 포함 — 직접 `JSON.parse` 금지.
- **프롬프트 변경 시 프롬프트 복원력 테스트 필수**: `buildSingleRulePrompt`의 섹션 구조를 바꾸면 LLM이 JSON 안 뱉을 수 있음. 온도 0.1, max_tokens 1000 고정.

### chunker/methodChunker.js

- 메서드 경계는 **`braceDepth` 기반 정규식** 근사. Java AST 라이브러리(`java-parser`)가 불완전해 채택. 제네릭(`List<Map<String, Integer>>`)/람다(`() -> {}`) 특수 케이스에서 이따금 오작동 가능.
- `extractSingleMethod`가 `null` 반환하면 해당 메서드는 **조용히 스킵** — 로그 꼭 확인.
- `codeWithHeader`, `headerLineCount`는 **레거시 필드** (현재 안 쓰임). 제거해도 무방하지만 다른 곳에서 참조 없는지 먼저 확인.

### chunker/chunkResultMerger.js

- `convertLineNumbers` 공식: `rangeStart + issue.line - 1`. **truncateCode가 발생하지 않은 경우에만 정확** (C2 이슈와 연관).
- 라인 번호 **클램핑** 수행 (`rangeStart ≤ line ≤ rangeEnd`). LLM이 범위 밖 라인 리포트해도 메서드 시작으로 말림.
- 중복 제거 키가 `codeChecker`와 다름 — 통일 필요 (H4 이슈).

### tagger/codeTagger.js

- 태그 추출 순서: **regex → ast → metrics → context → compound → (옵션) llm**.
- `compiledPatterns`는 초기화 시 한 번만 컴파일. **Push 후 재로드는 `resetCodeTagger()` 호출로**.
- **정규식 `lastIndex` 잔류** 이슈 방지를 위해 `extractByRegex`에서 매칭 전후로 전체 리셋 — 개별 리셋으로 돌아가지 말 것.
- `matchType`: `'any'`(하나라도), `'all'`(모두), `'none'`(비활성). `'none'`은 `compiledPatterns`에서 아예 제외됨.
- PCRE→JS 변환 로직(`_convertPCREtoJS`)은 `codeChecker._compilePattern`과 **완전 동일**해야 함. 한쪽 변경 시 다른 쪽도 동기화.

### ast/javaAstParser.js

- `java-parser` 대신 **정규식 기반 폴백 분석**. 정확도보다 안정성 우선.
- `createEmptyAnalysis()`와 `fallbackAnalysis()`의 반환 필드는 **`codeTagger`의 `extractByAst`가 요구하는 스키마와 맞아야 함**. 새 필드 추가 시 `createEmptyAnalysis`도 맞춰 업데이트.
- `analysis.detectedIssues`는 **미구현 필드** — `codeChecker.js:936`이 참조하지만 항상 undefined. 필요하면 구현하거나 참조 제거.

### clients/llmClient.js

- OpenAI 호환 API (`/v1/completions`). `/v1/chat/completions` 아님 — 프롬프트는 completion 방식.
- 타임아웃은 `AbortController` 기반. 180초 넘기면 자동 중단.
- 재시도는 **지수 백오프 3회**. 4xx는 재시도 안 함 (vLLM 동작 전제).
- `cleanAndExtractJSON`은 마크다운 코드펜스 제거 + 가장 유효한 JSON 객체 선택. 여러 JSON이 있으면 위반 `true`인 것 우선.

### clients/qdrantClient.js

- **컬렉션명별 Map으로 인스턴스 관리** (`instances` Map). 가이드라인/이슈 두 컬렉션을 같은 싱글톤으로 쓰면 오염됨 — 이전 버그.
- `scroll` API로 필터 기반 전수 조회. **벡터 유사도 검색 아님** — `scoreThreshold` 파라미터 무의미.
- `evaluateTagCondition`:
  1. `excludeTags` 하나라도 포함 → 제외
  2. `requiredTags` 모두 포함해야 함 (AND)
  3. `tagCondition` 표현식 평가 (`&&`, `||`, `!`, 괄호)

## 성능 튜닝 시 고려

- **청크 병렬 처리**: `codeChecker.checkCodeChunked`의 for 루프를 `Promise.all` + `p-limit(3~5)`로 바꾸면 2~5배 빨라짐. vLLM 동시 요청 한도 확인 후 concurrency 결정.
- **LLM 호출 수**: `filteringStats.llmCalls`로 모니터링. 후보 수가 많으면 `preFilterRules`의 `matchesContextualCondition`/`matchesAstCondition`을 더 타이트하게.
- **정규식 컴파일**: 초기화 시 1회. 런타임에 재컴파일 하지 말 것.
