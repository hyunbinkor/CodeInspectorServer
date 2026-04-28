# assets/ — 태그 정의 & 규칙 스키마

## 파일 역할

| 파일 | 용도 | 런타임 로드 경로 |
|---|---|---|
| `tags/tag-definitions.json` | 45개 태그 정의 (tier1 정규식, tier2 LLM, 복합 태그) | Qdrant 기반 로드 우선, JSON은 폴백 |
| `schema/ruleSchema.json` | 규칙 JSON Schema Draft 7 | 검증용 |

**실제 운영 환경**에서는 이 파일들이 **Qdrant에 복제되어 사용**됩니다. `assets/`의 JSON은:
- 첫 배포 시 초기 데이터 시드
- Qdrant 장애 시 폴백 (`JsonTagRepository`)
- 개발 시 참조용

**Qdrant와 `assets/` 파일이 불일치할 수 있음.** 운영 중 실제 태그/규칙은 `GET /api/data/pull`로 확인.

## tag-definitions.json 구조

```json
{
  "_metadata": { "version": "...", "description": "..." },
  "tagCategories": { "structure": "...", "resource": "...", ... },
  "tags": {
    "USES_CONNECTION": {
      "category": "resource",
      "description": "DB Connection 사용",
      "extractionMethod": "regex",   // "regex" | "llm" | "metric"
      "tier": 1,                     // 1=정규식/빠름, 2=LLM/느림
      "detection": {
        "type": "regex",
        "patterns": ["Connection\\s+\\w+", "\\.getConnection\\s*\\("],
        "matchType": "any",          // "any" | "all" | "none"
        "flags": "g",                // JS regex flags
        "excludeInComments": false,  // true면 주석/문자열 제거 후 매칭
        "caseSensitive": true        // false면 flags에 'i' 추가
      }
    },
    "HAS_LONG_METHOD": {
      "extractionMethod": "metric",
      "detection": {
        "type": "metric",
        "metric": "methodCount",    // lineCount | methodCount | complexity | nestingDepth
        "threshold": 30
      }
    }
  },
  "compoundTags": {
    "RISKY_DATABASE_OPERATION": {
      "composition": ["USES_CONNECTION", "HAS_SQL_CONCATENATION"],
      "operator": "AND"              // AND | OR
    }
  }
}
```

### 태그 추가 시 체크리스트

1. `tagCategories`에 카테고리 정의되어 있는지 확인 (없으면 추가).
2. 정규식 태그는 **PCRE 문법 피하기**. JS RegExp에서 지원되는 것만:
   - ❌ `(?P<name>...)`, `(?>...)`, `++`, `*+`, `?+`
   - ✅ `(?<name>...)`, `(?:...)`, `+`, `*`, `?`
   - PCRE 인라인 플래그 `(?i)`는 자동 변환되지만, 다른 PCRE 전용 기능은 조용히 실패.
3. 정규식 백슬래시는 **두 번 이스케이프** (`\\s`, `\\w`, `\\.`).
4. 추가 후 `POST /api/data/push`로 Qdrant 동기화. 서버는 자동으로 싱글톤 리셋.
5. **로컬 정규식 검증**:
   ```javascript
   new RegExp("Connection\\s+\\w+", "g").test("Connection conn")  // true 확인
   ```

### 태그 카테고리 (tagCategories 기준)

- `structure`: IS_CONTROLLER, IS_SERVICE, IS_DAO 등 클래스 역할
- `resource`: USES_CONNECTION, USES_STREAM 등 리소스 사용
- `pattern`: HAS_TRY_WITH_RESOURCES, HAS_EMPTY_CATCH 등 코드 패턴
- `call`: CALLS_SYSTEM_OUT, USES_REFLECTION 등 API 호출
- `financial`: USES_LDATA, USES_LMULTIDATA 등 금융권 특화
- `metric`: HAS_LONG_METHOD, HAS_HIGH_COMPLEXITY 등 지표 기반

## ruleSchema.json 구조

규칙 객체 필드:
- `ruleId` (필수, 형식: `[A-Z]{2,5}-[A-Z]?[0-9]{3}`)
- `title`, `description`, `category`, `severity` (필수)
- `checkType`: `pure_regex` | `llm_with_regex` | `llm_contextual` | `llm_with_ast`
- `requiredTags` (AND), `excludeTags` (AND), `tagCondition` (표현식)
- `antiPatterns[]`, `goodPatterns[]` (each `{ pattern, flags, description }`)
- `keywords[]`, `astHints`, `checkPoints[]`
- `message`, `suggestion`, `badExample`/`problematicCode`, `goodExample`/`fixedCode`
- `isActive` (boolean)

### 규칙 변경 시 체크리스트

1. 스키마 검증: `ruleSchema.json`과 맞는지 확인. 필드 추가 시 스키마도 업데이트.
2. `QdrantRuleRepository._parseRulePayload` (파싱)와 저장 로직 양쪽 필드 대응.
3. `DataService.diff`의 `RULE_COMPARE_FIELDS`에 새 필드 포함 — 안 하면 diff에서 변경 감지 안 됨.
4. `checkType` 변경 시 `preFilterRules`의 switch case 모두 처리되는지 확인.

## 백업 디렉토리 (`assets/backup/` 또는 `/tmp/backup/`)

- **런타임에 자동 생성**. 커밋된 파일은 예시/샘플로만 간주.
- 실제 운영 백업은 **Qdrant 내부에 저장** (`QdrantTagRepository`의 backup 기능).
