# Java Code Quality API Server

Java 코드 품질 검사 시스템의 REST API 서버입니다.

## 🚀 시작하기

### 사전 요구사항

- Node.js 18.0.0+
- Qdrant 벡터 데이터베이스
- vLLM 서버 (선택)

### 설치

```bash
# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 편집하여 설정

# 서버 시작
npm start

# 개발 모드 (nodemon)
npm run dev
```

## 📡 API 엔드포인트

### 헬스 체크

```
GET /health
```

### 코드 검사

```
POST /api/check
```

**요청:**
```json
{
  "code": "public class Example { ... }",
  "fileName": "Example.java",
  "options": {
    "format": "json"  // json | sarif | github
  }
}
```

**응답:**
```json
{
  "success": true,
  "fileName": "Example.java",
  "lineCount": 150,
  "chunked": false,
  "processingTimeMs": 1234,
  "issues": [...],
  "summary": {
    "totalIssues": 5,
    "bySeverity": { "HIGH": 2, "MEDIUM": 3 }
  }
}
```

### 데이터 Pull (다운로드)

```
GET /api/data/pull
```

전체 규칙과 태그 정의를 다운로드합니다.

**응답:**
```json
{
  "version": 1705750000000,
  "rules": {
    "count": 50,
    "items": [...]
  },
  "tags": { ... }
}
```

### 데이터 Diff (변경사항 미리보기)

```
POST /api/data/diff
```

로컬 데이터와 서버 데이터를 비교합니다.

**요청:**
```json
{
  "baseVersion": 1705750000000,
  "rules": [...],
  "tags": { ... }
}
```

### 데이터 Push (업로드)

```
POST /api/data/push
```

전체 데이터를 서버에 업로드합니다. 자동으로 백업이 생성됩니다.

**요청:**
```json
{
  "baseVersion": 1705750000000,
  "rules": [...],
  "tags": { ... },
  "force": false  // 버전 충돌 시 강제 덮어쓰기
}
```

## 📁 프로젝트 구조

```
src/
├── api/
│   ├── routes/           # API 라우트
│   │   ├── check.routes.js
│   │   └── data.routes.js
│   └── middlewares/      # 미들웨어
├── services/             # 비즈니스 로직
│   ├── checkService.js
│   └── dataService.js
├── repositories/         # 데이터 접근 계층
│   ├── IRuleRepository.js
│   ├── ITagRepository.js
│   └── impl/
│       ├── QdrantRuleRepository.js
│       └── JsonTagRepository.js
├── core/                 # 핵심 모듈 (기존 코드)
│   ├── checker/
│   ├── chunker/
│   ├── tagger/
│   ├── ast/
│   └── clients/
├── config/
├── utils/
└── app.js                # Express 앱
```

## 🔧 아키텍처

### Repository 패턴

DB 추상화를 위해 Repository 패턴을 적용했습니다:

```javascript
// 인터페이스
class IRuleRepository {
  async findAll() {}
  async findByTags(tags) {}
  async saveAll(rules) {}
}

// Qdrant 구현체
class QdrantRuleRepository extends IRuleRepository { ... }

// 추후 다른 DB 구현체 가능
class PostgresRuleRepository extends IRuleRepository { ... }
```

### Pull/Diff/Push 방식

실시간 CRUD 대신 전체 데이터 동기화 방식:

1. **Pull**: 서버에서 전체 데이터 다운로드 (버전 포함)
2. **로컬 편집**: 클라이언트에서 규칙/태그 추가/수정/삭제
3. **Diff**: Push 전 변경사항 미리보기 (충돌 확인)
4. **Push**: 전체 데이터 업로드 (자동 백업)

## 📝 환경변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| PORT | 서버 포트 | 3000 |
| VLLM_BASE_URL | vLLM 서버 URL | http://localhost:8000 |
| VLLM_MODEL | 모델명 | Qwen/Qwen2.5-Coder-32B-Instruct |
| QDRANT_HOST | Qdrant 호스트 | localhost |
| QDRANT_PORT | Qdrant 포트 | 443 |
| QDRANT_COLLECTION | 컬렉션명 | rules |
| LOG_LEVEL | 로그 레벨 | info |

## 📌 출력 형식

### JSON (기본)

기본 JSON 형식으로 이슈 목록과 요약 제공

### SARIF

IDE/CI 통합을 위한 SARIF 2.1.0 형식

## 📄 라이선스

MIT
