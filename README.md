# Code Inspector Server

Java 코드 품질 검사 REST API 서버. 정규식 + LLM(vLLM) + 벡터 DB(Qdrant)를 조합한 하이브리드 검사 엔진. 금융권 내부망 환경 대응.

## Quick Start

**요구사항**: Node.js 22+, Qdrant 인스턴스, vLLM 서버

```bash
npm install
cp .env.example .env       # Windows: copy .env.example .env
# .env의 CHANGE_ME 값들을 실제 환경에 맞게 채워넣기
npm run dev                # 개발 (nodemon) / 운영은 npm start
curl http://localhost:3000/health
```

Docker 빌드/배포는 [`DEPLOYMENT.md`](./DEPLOYMENT.md) 참조.

## API

| Method | Path | 용도 |
|---|---|---|
| GET  | `/health` | 헬스체크 |
| GET  | `/api` | 사용 가능한 엔드포인트 목록 |
| POST | `/api/check` | 코드 검사 (heartbeat 응답) |
| GET  | `/api/check/stats` | 필터링 통계 |
| GET  | `/api/data/pull` | 규칙+태그 다운로드 |
| POST | `/api/data/diff` | 로컬 vs 서버 변경사항 비교 |
| POST | `/api/data/push` | 규칙+태그 업로드 (자동 백업) |

`/api/check` 요청/응답 예시:

```json
// 요청
{
  "code": "public class Example { ... }",
  "fileName": "Example.java",
  "options": { "format": "json" }   // json | sarif | github
}

// 응답
{
  "success": true,
  "issues": [{ "ruleId": "RES-001", "line": 10, "severity": "HIGH", ... }],
  "summary": { "totalIssues": 3, "bySeverity": { "HIGH": 1, ... } },
  "processingTimeMs": 2450
}
```

> **Heartbeat 주의**: `/api/check`은 `Transfer-Encoding: chunked`로 15초마다 공백 문자(`\n`)를 전송한다. 클라이언트는 `JSON.parse(body.trim())`으로 파싱할 것.

## 환경 변수

전체 목록과 기본값은 [`.env.example`](./.env.example) 참조. 핵심:

- `VLLM_BASE_URL`, `VLLM_MODEL` — LLM 서버
- `QDRANT_HOST`, `QDRANT_PORT` — 벡터 DB
- `CORS_ORIGIN` — 운영에서는 화이트리스트 권장
- `NODE_TLS_REJECT_UNAUTHORIZED` — 자체 서명 인증서 사용 시. CA 마운트가 우선.

## 개발

```bash
npm run dev                # nodemon
node test-api.js [url]     # vLLM/Qdrant 의존 통합 테스트
```

**트러블슈팅**:
- *Windows 로컬 실행 시*: 기본값이 `/tmp/...`라 즉시 실패. `.env`의 `TAGS_PATH`/`BACKUP_PATH`를 절대 경로로 지정.
- *vLLM 미가용*: 서버는 정상 부팅되지만 `/api/check`은 LLM 검증 단계에서 실패. `pure_regex` 규칙만 동작.
- *Qdrant 연결 실패*: 시작 시 경고 후 빈 규칙 셋으로 폴백. `/api/data/pull`이 빈 배열 반환.

## 아키텍처

```
클라이언트 → Express → CheckService → CodeChecker
                                       ├── CodeTagger    (정규식 + AST)
                                       ├── JavaAstParser
                                       ├── RuleRepository (Qdrant)
                                       ├── LLMClient      (vLLM)
                                       └── MethodChunker  (3000줄+ 분할)
```

`v4.0` 단계적 필터링 — `pure_regex` → `llm_with_regex` → `llm_contextual` → `llm_with_ast`.
원칙: **"탐지는 넓게, 검증은 좁게"**.

## 알려진 이슈

진행 중인 작업과 잠재 버그는 [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) 참조.

## 라이선스

개발 중. 추후 사내 표준에 맞춰 LICENSE 파일 추가 예정.
