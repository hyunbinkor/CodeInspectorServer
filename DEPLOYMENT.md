# Code Quality Server 배포 가이드

## 1. 개요

| 항목 | 내용 |
|------|------|
| **서비스명** | Java 코드 품질 검사 API 서버 |
| **버전** | 1.0.0 |
| **빌드일** | 2026-01-23 |
| **담당자** | [담당자명] / [연락처] |
| **기술 스택** | Node.js 22, Express, Qdrant, vLLM |

---

## 2. 시스템 요구사항

### 컨테이너 리소스
| 항목 | 최소 | 권장 |
|------|------|------|
| CPU | 1 core | 2 cores |
| Memory | 512MB | 1GB |
| Disk | 500MB | 1GB |

### 네트워크 요구사항
| 대상 | 포트 | 프로토콜 | 용도 |
|------|------|----------|------|
| **Qdrant 서버** | 443 | TCP/HTTP | 벡터 DB 연결 |
| **vLLM 서버** | 8000 | TCP/HTTP | LLM API 연결 |
| **API 서비스** | 3000 | TCP/HTTP | 클라이언트 요청 수신 |

---

## 3. 이미지 로드

```bash
# 압축 파일로 전달받은 경우
docker load < code-quality-server_1.0.0.tar.gz

# 로드 확인
docker images | grep code-quality-server
```

**예상 출력:**
```
code-quality-server   1.0.0   abc123def456   2 minutes ago   180MB
```

---

## 4. 컨테이너 실행

### 4.1 기본 실행 (환경변수 기본값 사용)
```bash
docker run -d \
  --name code-quality \
  -p 3000:3000 \
  --restart unless-stopped \
  code-quality-server:1.0.0
```

### 4.2 환경변수 지정 실행 (권장)
```bash
docker run -d \
  --name code-quality \
  -p 3000:3000 \
  --restart unless-stopped \
  -e QDRANT_HOST=192.168.100.10 \
  -e QDRANT_PORT=443 \
  -e VLLM_BASE_URL=http://192.168.100.20:8000 \
  -e LOG_LEVEL=info \
  code-quality-server:1.0.0
```

### 4.3 환경변수 파일 사용
```bash
# env.list 파일 생성
cat > env.list << EOF
QDRANT_HOST=192.168.100.10
QDRANT_PORT=443
VLLM_BASE_URL=http://192.168.100.20:8000
LOG_LEVEL=info
EOF

# 환경변수 파일로 실행
docker run -d \
  --name code-quality \
  -p 3000:3000 \
  --restart unless-stopped \
  --env-file env.list \
  code-quality-server:1.0.0
```

---

## 5. 환경변수 목록

| 변수명 | 기본값 | 설명 | 수정 필요 |
|--------|--------|------|----------|
| `PORT` | 3000 | API 서버 포트 | 선택 |
| `HOST` | 0.0.0.0 | 바인딩 주소 | 선택 |
| `NODE_ENV` | production | 실행 환경 | 유지 |
| `CORS_ORIGIN` | * | CORS 허용 도메인 | 선택 |
| **`QDRANT_HOST`** | qdrant-server | Qdrant 서버 주소 | **필수** |
| `QDRANT_PORT` | 443 | Qdrant 포트 | 선택 |
| `QDRANT_COLLECTION` | rules | 컬렉션 이름 | 유지 |
| **`VLLM_BASE_URL`** | http://vllm-server:8000 | vLLM 서버 URL | **필수** |
| `VLLM_MODEL` | Qwen/Qwen2.5-Coder-32B-Instruct | 모델명 | 유지 |
| `VLLM_TIMEOUT` | 180000 | 타임아웃(ms) | 선택 |
| `LOG_LEVEL` | info | 로그 레벨 (error/warn/info/debug) | 선택 |
| `NODE_TLS_REJECT_UNAUTHORIZED` | (unset) | TLS 인증서 검증. 자체 서명 인증서 사용 시 0 | 환경따라 |

> **TLS 검증 안내**
> 내부망 Qdrant/vLLM이 자체 서명 인증서를 사용하면 컨테이너 시작 시 TLS 핸드셰이크가 실패할 수 있습니다.
> - **권장**: 사내 CA 인증서를 컨테이너에 마운트 (`-v /path/to/ca.crt:/etc/ssl/certs/internal-ca.crt`).
> - **임시 우회**: `-e NODE_TLS_REJECT_UNAUTHORIZED=0` — MITM에 취약하므로 격리된 내부망에서만 사용.
> 이전 이미지(<=1.0.0)는 기본값으로 `0`을 설정했으나, 보안 영향이 커 1.0.x 이후 제거되었습니다.

---

## 6. 상태 확인

### 6.1 헬스체크
```bash
# 컨테이너 상태 확인
docker ps

# API 헬스체크
curl http://localhost:3000/health
```

**정상 응답:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-23T10:30:00.000Z",
  "version": "1.0.0"
}
```

### 6.2 API 엔드포인트 확인
```bash
curl http://localhost:3000/api
```

**응답:**
```json
{
  "name": "Code Quality API",
  "version": "1.0.0",
  "endpoints": {
    "check": {
      "POST /api/check": "코드 검사 실행"
    },
    "data": {
      "GET /api/data/pull": "전체 데이터 다운로드",
      "POST /api/data/diff": "변경사항 미리보기",
      "POST /api/data/push": "전체 데이터 업로드"
    }
  }
}
```

### 6.3 코드 검사 테스트
```bash
curl -X POST http://localhost:3000/api/check \
  -H "Content-Type: application/json" \
  -d '{
    "code": "public class Test { public void hello() {} }",
    "fileName": "Test.java"
  }'
```

---

## 7. 로그 확인

```bash
# 실시간 로그 확인
docker logs -f code-quality

# 최근 100줄
docker logs --tail 100 code-quality

# 특정 시간 이후 로그
docker logs --since 1h code-quality
```

---

## 8. 트러블슈팅

### 문제: 컨테이너가 시작 후 바로 종료됨
```bash
# 로그 확인
docker logs code-quality

# 환경변수 확인
docker inspect code-quality | grep -A 50 "Env"
```

### 문제: Qdrant 연결 실패
```
❌ Qdrant 연결 실패: connect ECONNREFUSED
```
**해결:** `QDRANT_HOST` 환경변수가 올바른 IP인지 확인

### 문제: vLLM 연결 실패
```
❌ vLLM 서버 연결 실패
```
**해결:** `VLLM_BASE_URL` 환경변수가 올바른 URL인지 확인

### 문제: 헬스체크 실패 (unhealthy)
```bash
# 컨테이너 내부 접속
docker exec -it code-quality sh

# 내부에서 헬스체크 직접 실행
wget -q -O- http://localhost:3000/health
```

---

## 9. 컨테이너 관리

```bash
# 중지
docker stop code-quality

# 시작
docker start code-quality

# 재시작
docker restart code-quality

# 삭제
docker rm -f code-quality

# 이미지 삭제
docker rmi code-quality-server:1.0.0
```

---

## 10. 버전 히스토리

| 버전 | 날짜 | 변경 내용 |
|------|------|----------|
| 1.0.0 | 2026-01-23 | 최초 배포 |

---

## 11. 긴급 연락처

| 구분 | 담당자 | 연락처 |
|------|--------|--------|
| 개발 담당 | [이름] | [전화/이메일] |
| 운영 담당 | [이름] | [전화/이메일] |
