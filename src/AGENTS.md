# src/ — 계층 구조 및 의존성 규칙

## 계층 (의존성은 항상 위 → 아래 한 방향)

```
api/              ← HTTP 경계. Express 라우터와 미들웨어만.
  ↓
services/         ← 비즈니스 로직 래퍼. 라우터에서 쓰는 진입점.
  ↓
core/             ← 검사 엔진 핵심. 순수 도메인 로직.
  ├── checker/
  ├── chunker/
  ├── tagger/
  ├── ast/
  └── clients/    ← 외부 서비스 (vLLM, Qdrant) — I/O 경계
  ↓
repositories/     ← 데이터 접근 추상화. 인터페이스(I*.js) + 구현(impl/).
  ↓
config/           ← 환경변수 → 설정 객체. 순수 데이터.
utils/            ← 순수 유틸. 어디서든 import 가능.
```

### 규칙
1. **`core/` ↔ `api/` 직접 import 금지**. 반드시 `services/`를 거칠 것.
2. **`repositories/impl/`을 직접 import 하지 말고** `get*Repository()` 팩토리 사용. DB 교체 시 팩토리만 수정.
3. `utils/`는 모든 레이어에서 import 허용. 단, utils가 core/api를 import하면 순환 참조 → 금지.
4. **싱글톤 패턴**: 모든 서비스/레포지토리는 `getXxx()` / `resetXxx()` 쌍을 제공. 테스트/Push 후 리셋용.

## ESM 유의사항

- `package.json`이 `"type": "module"`. **모든 import는 확장자 `.js` 명시** 필수:
  ```javascript
  import { getCodeChecker } from './core/checker/codeChecker.js';  // ✓
  import { getCodeChecker } from './core/checker/codeChecker';     // ✗ 런타임 에러
  ```
- `require()` 사용 불가. 동적 import는 `await import()`.
- `__dirname`, `__filename` 없음. 필요 시:
  ```javascript
  import { fileURLToPath } from 'url';
  import path from 'path';
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  ```

## 에러 처리 컨벤션

- 라우터: 예외는 `next(error)` → `errorHandler` 미들웨어에서 처리. 직접 `res.status(500).json()`은 `/api/check`의 heartbeat 처리처럼 **응답 헤더가 이미 전송된 경우**에만.
- 서비스/core: 복구 가능한 실패는 `logger.warn` + 빈 결과 반환. 복구 불가는 `throw`.
- Qdrant 연결 실패: 애플리케이션 전체 중단 X. 경고 로그 후 빈 배열로 폴백 (`QdrantRuleRepository.findAll` 참고).

## 로깅

- `utils/loggerUtils.js`의 `logger` 사용. `console.log`/`console.error` 금지.
- 형식: `[모듈명] 메시지` 또는 `[${fileName}] 메시지`. 기존 관행 유지.
- `debug`/`trace`는 대량 출력 가능. 운영 로그 레벨은 `info`.

## 설정 접근

- `src/config/index.js`의 `config` 객체만 import. `process.env.*` 직접 접근 금지 (테스트 어려움).
  ```javascript
  import { config } from '../config/index.js';
  const url = config.llm.baseUrl;
  ```
