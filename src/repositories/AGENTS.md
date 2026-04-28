# src/repositories/ — Repository 패턴

## 구조

```
repositories/
├── IRuleRepository.js     ← 인터페이스 (extends 대상)
├── ITagRepository.js
└── impl/
    ├── QdrantRuleRepository.js   ← 가이드라인 + 이슈 2개 컬렉션 병합
    ├── QdrantTagRepository.js    ← 단일 포인트 ID 전략
    └── JsonTagRepository.js      ← 로컬 JSON 폴백 (초기화/테스트용)
```

## 인터페이스 변경 규칙

- `I*Repository.js`에 메서드 추가 시 **모든 `impl/` 구현체 동시 업데이트** 필수.
- 현재 Qdrant 구현만 있지만, 향후 PostgreSQL/MongoDB 구현이 추가될 수 있음을 전제로 설계.
- 메서드는 **항상 async**. 동기 메서드 추가 금지.

## 팩토리 & 싱글톤

```javascript
// 항상 get*Repository() 호출. new로 직접 생성 금지.
import { getQdrantRuleRepository } from './impl/QdrantRuleRepository.js';
const repo = getQdrantRuleRepository();
await repo.initialize();   // idempotent
```

- `resetQdrantRuleRepository()`는 **Push 후 호출**됨 (`DataService.push` 말미). 이 순서 바꾸면 규칙 변경이 다음 검사에 반영 안 됨.

## QdrantRuleRepository 특이사항

- **두 컬렉션 병합 조회**: `rules` (가이드라인) + `issues` (이슈). `findAll`, `findByTags` 모두 `Promise.all`로 병렬 조회 후 concat.
- `issues` 컬렉션은 **없을 수도 있음** — 초기화 실패 시 `this.issueQdrantClient = null` 설정 후 빈 배열로 폴백.
- `save`/`saveAll`은 **가이드라인 컬렉션에만 기록** — 이슈 컬렉션은 읽기 전용 취급.

## QdrantTagRepository 특이사항

- **단일 포인트 ID**: `00000000-0000-0000-0000-000000000001` 에 전체 태그 데이터를 저장.
  - 장점: 원자적 읽기/쓰기, 버전 관리 단순
  - 단점: 개별 태그 수정도 전체 replace
- `getAllData()` / `replaceAllData()` 쌍으로만 사용. 개별 CRUD 메서드 추가 금지.
- **백업 기능 내장** (`[Fix #7]`): Push 전 Qdrant에 자동 백업. `/tmp/backup`은 컨테이너 재시작 시 소실되므로 사용 X.

## JsonTagRepository

- 로컬 `assets/tags/tag-definitions.json` 파일 기반. Qdrant 미가용 시 폴백.
- 쓰기 작업 지원하지만 **프로덕션 환경에서는 읽기 전용으로 사용**. 파일 동시 쓰기 race 없음 보장 안 됨.

## 새 Repository 구현 추가 시

1. `I*Repository.js`의 모든 메서드 구현
2. `get*Repository()` / `reset*Repository()` 팩토리 export
3. `initialize()`는 멱등(idempotent)
4. `DataService` (services/)에서 환경 변수나 config로 구현체 선택하도록 수정
5. `app.js` startup diagnostic에 연결 확인 추가
