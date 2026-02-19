#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Docker 이미지 빌드 및 내보내기 스크립트 (Linux/Mac)
# ═══════════════════════════════════════════════════════════════════════════

set -e

# 설정
IMAGE_NAME="code-quality-server"
IMAGE_TAG="1.0.0"
FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
TAR_FILE="${IMAGE_NAME}-${IMAGE_TAG}.tar"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Code Quality Server - Docker 빌드"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Docker 실행 확인
if ! docker version &> /dev/null; then
    echo "[오류] Docker가 실행되지 않았습니다."
    exit 1
fi

echo "[1/4] Docker 이미지 빌드 중..."
echo "     이미지: ${FULL_IMAGE}"
echo ""

docker build -t ${FULL_IMAGE} .

echo ""
echo "[2/4] 빌드 완료. 이미지 정보:"
docker images ${IMAGE_NAME}
echo ""

echo "[3/4] 이미지를 tar 파일로 내보내는 중..."
echo "     파일: ${TAR_FILE}"
docker save -o ${TAR_FILE} ${FULL_IMAGE}

echo ""
echo "[4/4] 완료!"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  결과물"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  이미지:     ${FULL_IMAGE}"
echo "  파일:       ${TAR_FILE}"
echo "  크기:       $(du -h ${TAR_FILE} | cut -f1)"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  CI/CD 부서에 전달할 파일"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  1. ${TAR_FILE}      (Docker 이미지)"
echo "  2. DEPLOY.md              (배포 가이드)"
echo "  3. docker-compose.yml     (참고용)"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo ""
