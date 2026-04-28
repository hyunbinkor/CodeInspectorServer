# Known Issues

미해결 이슈 목록. 각 항목은 향후 PR로 해결 예정. PR 머지 시 해당 항목 제거.

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
| M4 | 유지보수성 | 하 |
