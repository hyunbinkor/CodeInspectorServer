# CodeInspectorServer — Agent 작업 지침

금융권(신한카드) 내부망용 **Java 코드 품질 검사 REST API 서버**. 정규식 + LLM(vLLM) + 벡터DB(Qdrant)를 조합한 하이브리드 검사 엔진.

## 1. 한눈에 보는 아키텍처

```
클라이언트(IDE 플러그인)
    ↓ POST /api/check  (heartbeat 15s)
Express 라우터 (src/api/routes)
    ↓
CheckService (src/services)
    ↓
CodeChecker (src/core/checker)         ← 검사 엔진 핵심
  ├── CodeTagger       (src/core/tagger)    ─ 태그 추출 (정규식 + AST + LLM)
  ├── JavaAstParser    (src/core/ast)       ─ 정규식 기반 구조 분석
  ├── RuleRepository   (src/repositories)   ─ Qdrant에서 규칙 조회
  ├── LLMClient        (src/core/clients)   ─ vLLM OpenAI 호환 API
  ├── MethodChunker    (src/core/chunker)   ─ 3000줄↑ 파일 메서드 단위 분할
  └── ResultBuilder    (src/core/checker)   ─ 이슈 집계/포맷팅
```

**v4.0 단계적 필터링** (`checkType` 기반):
- `pure_regex`       — 정규식만으로 확정
- `llm_with_regex`   — 정규식 후보 → LLM 검증
- `llm_contextual`   — 태그/키워드 필터 → LLM 분석
- `llm_with_ast`     — AST 정보 + LLM 검증

원칙: **"탐지는 넓게, 검증은 좁게"** — False Negative 최소화.

## 2. 실행 / 개발

```bash
# 개발 모드 (nodemon)
npm run dev

# 프로덕션
npm start

# Docker 빌드
./build-docker.sh      # Linux
build-docker.bat       # Windows

# API 수동 테스트
node test-api.js
```

- **Node.js 18+ 필수** (ESM, `type: "module"`)
- **테스트 프레임워크 없음**. `npm test`는 placeholder. 테스트 추가 시 Vitest 권장 (ESM 네이티브).
- **Lint 설정 없음**. PR 시 직접 스타일 맞춤.

## 3. 환경 변수 (.env)

| 변수 | 용도 | 예시 |
|---|---|---|
| `PORT`, `HOST` | Express 바인딩 | `3000`, `0.0.0.0` |
| `VLLM_BASE_URL` | vLLM OpenAI 호환 엔드포인트 | `http://10.131.48.41:11434` |
| `VLLM_MODEL` | 모델 ID | `ShcCodeAssistant` |
| `VLLM_TIMEOUT` | LLM 호출 타임아웃(ms) | `180000` |
| `VLLM_MAX_TOKENS` | **64000** — 선택 검사 길이 제한 산정 기준 | `64000` |
| `QDRANT_HOST/PORT/HTTPS` | Qdrant 접속 | 내부망 host |
| `QDRANT_COLLECTION` | 가이드라인 규칙 컬렉션 | `rules` |
| `QDRANT_ISSUE_COLLECTION` | 이슈 기반 규칙 컬렉션 | `issues` |
| `LOG_LEVEL` | `error`/`warn`/`info`/`debug`/`trace` | `info` |

**내부망 환경 전제**: 외부 인터넷 차단됨. 새 의존성 추가 시 오프라인 설치 가능해야 함.

## 4. API 엔드포인트 요약

| Method | Path | 용도 |
|---|---|---|
| GET  | `/health` | Liveness |
| POST | `/api/check` | 코드 검사 (heartbeat 응답) |
| GET  | `/api/check/stats` | 필터링 통계 |
| POST | `/api/check/stats/reset` | 통계 초기화 |
| GET  | `/api/data/pull` | 규칙+태그 전체 다운로드 |
| POST | `/api/data/diff` | 로컬 vs 서버 변경사항 비교 |
| POST | `/api/data/push` | 규칙+태그 업로드 (자동 백업) |
| GET  | `/api/data/stats` | 규칙/태그 통계 |

**/api/check 응답 형식의 특이사항**:
- `Transfer-Encoding: chunked` + `X-Content-Streaming: heartbeat`
- 15초마다 `\n` 전송하여 프록시 타임아웃 방지
- 클라이언트는 `JSON.parse(body.trim())`로 파싱

## 5. 절대 건드리면 안 되는 것

1. **Heartbeat 메커니즘** (`src/api/routes/check.routes.js`) — 금융권 프록시가 15초 무응답 시 연결 끊음. 제거 불가.
2. **싱글톤 리셋 호출 순서** (`DataService.push` 후) — `resetTagDefinitionLoader → resetCodeTagger → resetQdrantRuleRepository → resetCodeChecker → resetCheckService`. 빠뜨리면 규칙 변경이 다음 검사에 반영 안 됨.
3. **PCRE→JS 정규식 변환 로직** (`_convertPCREtoJS`) — `codeTagger.js`와 `codeChecker.js` 양쪽에 복제되어 있음. 한쪽만 수정 금지, 둘 다 동기화.
4. **Qdrant scroll API의 `limit: 10000`** — 규칙 수 증가 대비 하드코딩. 쿼리 방식 바꾸려면 페이지네이션 도입 후 변경.
5. **Qdrant 태그 저장 단일 포인트 ID** (`00000000-0000-0000-0000-000000000001`) — 전체 태그를 한 포인트에 저장하는 전략. 바꾸면 기존 데이터 마이그레이션 필요.

## 6. 커밋 / PR 컨벤션

- 버그 수정은 코드 주석에 `[Fix #번호]` 또는 `[Fix 단문설명]` 형식으로 근거 남기기. 기존 관행 유지.
- 공개 인터페이스(`I*Repository`) 변경 시 구현체(`impl/`) 전부 동기화.
- 규칙 스키마(`assets/schema/ruleSchema.json`) 변경 시 `QdrantRuleRepository._parseRulePayload`와 `ruleSchema` 파서 함께 업데이트.
- 한글 주석/로그 메시지 허용 (팀 표준). 새 파일에도 동일.
- **테스트 있으면 PR 전에 돌리기** (현재는 없음). LLM 관련 변경은 `test-api.js`로 수동 확인.

## 7. 알려진 미해결 이슈 (2026-04 기준)

### 🔴 Critical
| # | 문제 | 위치 | 영향 |
|---|---|---|---|
| C1 | 청킹 모드에서 **class-level 태그 누락** (메서드 청크에 `@Service`, `class XXX extends DAO` 등이 떨어져나감) | `codeChecker.js:296`, `checkCodeDirect` | 파일 검사(청킹)에서도 `IS_DAO`/`IS_SERVICE` 요구 규칙이 누락됨. 해결: 청킹 진입 시 원본 전체로 global tag 추출 후 각 청크에 병합 전달. |
| C2 | **`truncateCode` 후 라인 번호 어긋남** — `// ... (N줄 생략) ...` 주석 삽입 후 `addLineNumbers(1부터)` 호출. LLM이 리포트한 line이 원본과 다름 | `codeChecker.js:783-786`, `truncateCode` | 80KB 초과 코드 (선택 검사 ≥6000줄 시)의 결과 라인이 전부 어긋남. 해결: `addLineNumbers`를 truncation 이전에 호출하고 truncation은 prefix 보존하도록 수정. |
| C3 | `filteringStats`가 **싱글톤 CodeChecker 속성** — 동시 검사 요청 시 서로 덮어씀 | `codeChecker.js:71-77,169` | 응답의 `stats.llmCalls` 값이 다른 요청 것일 수 있음. 해결: 지역 변수로 이동. |

### 🟡 High
- **H1**: Header/Footer 청크는 `continue`로 스킵 → import 관련 규칙(deprecated API, wildcard import 금지 등) 영구 미탐지. `codeChecker.js:276-280`.
- **H2**: 청크 순차 처리 (`for` 루프) — 병렬화(p-limit + concurrency 3~5) 가능.
- **H3**: `verifyWithLLM` 루프에 `_sleep(100)` — vLLM rate limit 없으면 제거.
- **H4**: 중복 제거 키가 `codeChecker.deduplicateViolations`와 `chunkResultMerger.deduplicateIssues`가 서로 다름 (`description` 앞 50자 여부). 통일 필요.

### 🟢 Medium (코드 정리)
- `checkCode` 일반 모드와 `checkCodeDirect`가 거의 동일 — 전자가 후자 호출하도록 통합.
- `astAnalysis.detectedIssues` 참조는 **데드 코드** (`javaAstParser`에 해당 필드 없음) — `codeChecker.js:936`.
- `chunk.codeWithHeader`, `chunk.headerLineCount` 레거시 — 현재 아무도 안 씀.
- `buildGitHubAnnotations`에서 message 내 줄바꿈을 `%0A`로 이스케이프 안 함.

### 선택 검사(`checkMode: 'selection'`) 관련
- 라우터에서 `req.body.options.checkMode`를 **추출/전달하지 않음** (`check.routes.js:128`). 한 줄 수정으로 활성화됨.
- 활성화 시 **선택 검사 hard limit 6000줄** 추가 권장 (vLLM 64K 토큰 기준).
- 플러그인 측은 선택 영역을 **가장 가까운 메서드 경계로 자동 확장**해서 보낼 것. AST 기반(IntelliJ PSI, LSP `documentSymbol`) 권장.

## 8. 파일별 상세 지침

| 경로 | AGENTS.md |
|---|---|
| `src/` | 계층 간 의존성 규칙 |
| `src/core/` | 검사 엔진 핵심 로직 주의사항 |
| `src/repositories/` | Repository 패턴 가이드 |
| `assets/` | 태그/규칙 스키마 변경 가이드 |

각 디렉토리의 `AGENTS.md`를 읽고 작업할 것.

## 9. 참고 문서
- `README.md` — API 사용법 상세
- `DEPLOYMENT.md` — 배포 가이드
- `assets/schema/ruleSchema.json` — 규칙 JSON Schema
- `assets/tags/tag-definitions.json` — 태그 정의 (45개)
