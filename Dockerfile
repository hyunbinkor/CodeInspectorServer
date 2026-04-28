# ═══════════════════════════════════════════════════════════════════════════
# Java Code Quality API Server
# ═══════════════════════════════════════════════════════════════════════════
#
# [빌드 방법]
#   docker build -t code-quality-server:1.0.0 .
#
# [실행 방법]
#   docker run -d -p 3000:3000 --name code-quality code-quality-server:1.0.0
#
# [환경변수 덮어쓰기] (필요시)
#   docker run -d -p 3000:3000 \
#     -e QDRANT_HOST=192.168.1.100 \
#     -e VLLM_BASE_URL=http://192.168.1.101:8000 \
#     code-quality-server:1.0.0
#
# [이미지 저장/전달]
#   docker save code-quality-server:1.0.0 | gzip > code-quality-server_1.0.0.tar.gz
#   docker load < code-quality-server_1.0.0.tar.gz
#
# ═══════════════════════════════════════════════════════════════════════════

# Node.js 22 LTS (Alpine = 경량 이미지)
FROM node:22-alpine

# ───────────────────────────────────────────────────────────────────────────
# 메타데이터 (이미지 정보 조회: docker inspect)
# ───────────────────────────────────────────────────────────────────────────
LABEL maintainer="your-team@company.com"
LABEL description="Java Code Quality Inspection API Server"
LABEL version="1.0.0"
LABEL build-date="2026-01-23"

# 작업 디렉토리 설정
WORKDIR /app

# 빌드 시 필요한 도구 설치 (native 모듈 컴파일용)
RUN apk add --no-cache python3 make g++

# 패키지 파일 먼저 복사 (레이어 캐싱 활용)
COPY package.json package-lock.json ./

# 의존성 설치 (production만)
RUN npm ci --only=production && \
    npm cache clean --force

# 빌드 도구 제거 (이미지 크기 축소)
RUN apk del python3 make g++

# 소스 코드 복사
COPY src/ ./src/
COPY assets/ ./assets/

# ───────────────────────────────────────────────────────────────────────────
# 환경 변수 (이미지에 포함)
# 운영팀이 docker run -e 로 덮어쓰기 가능
# ───────────────────────────────────────────────────────────────────────────

# 서버 설정
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# CORS 설정 (운영에서는 화이트리스트 권장)
ENV CORS_ORIGIN=*

# TLS 검증
# 내부망에서 자체 서명 인증서를 사용하는 경우 docker run -e NODE_TLS_REJECT_UNAUTHORIZED=0
# 으로 주입할 수 있으나, 가능하면 CA 체인을 컨테이너에 마운트하여 검증을 유지할 것.
# 보안 영향이 크므로 이미지 기본값으로는 설정하지 않는다.

# ─── 쓰기 경로 설정 (/tmp 사용 - 권한 문제 우회) ───
ENV BACKUP_PATH=/tmp/backup
ENV TAGS_PATH=/tmp/tags

# ─── vLLM 설정 (운영 환경에서 docker run -e로 반드시 주입) ───
# 기본값은 placeholder. 실제 내부망 주소는 .env 또는 docker run -e VLLM_BASE_URL=... 으로 지정
ENV VLLM_BASE_URL=http://CHANGE_ME:11434
ENV VLLM_MODEL=CHANGE_ME
ENV VLLM_TIMEOUT=180000
ENV VLLM_MAX_RETRIES=3

# ─── Qdrant 설정 (운영 환경에서 docker run -e로 반드시 주입) ───
ENV QDRANT_HOST=CHANGE_ME
ENV QDRANT_PORT=443
ENV QDRANT_HTTPS=true
ENV QDRANT_COLLECTION=rules

# 로깅 설정 (debug로 변경하면 상세 로그)
ENV LOG_LEVEL=info

# ───────────────────────────────────────────────────────────────────────────
# 실행 설정
# ───────────────────────────────────────────────────────────────────────────

# 헬스체크 설정 (컨테이너 상태 모니터링)
# Liveness probe — 프로세스 생존만 확인 (의존성 다운 시 재시작 방지)
# Readiness 점검은 오케스트레이터(K8s 등)에서 /readyz로 별도 폴링 권장
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/livez || exit 1

# 포트 노출
EXPOSE 3000

# 실행 명령 (시작 시 /tmp에 디렉토리 생성 + 태그 파일 복사)
CMD ["sh", "-c", "mkdir -p /tmp/backup /tmp/tags && cp -r /app/assets/tags/* /tmp/tags/ 2>/dev/null; node src/app.js"]