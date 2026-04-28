/**
 * 코드 검사 API 라우트
 * 
 * POST /api/check - 코드 검사 실행 (heartbeat keepalive 지원)
 * 
 * 금융권 내부망 프록시 환경에서 장시간 처리 시 연결이 끊기는 문제 방지를 위해
 * 처리 중 주기적으로 공백 문자를 전송하여 연결을 유지합니다.
 * 
 * 응답 형식:
 *   - 처리 중: 공백 문자(\n) 주기적 전송 (프록시 keepalive)
 *   - 완료 시: JSON 결과 전송
 *   - 클라이언트는 JSON.parse(body.trim()) 또는 JSON.parse(body)로 파싱 가능
 * 
 * @module api/routes/check.routes
 */

import { Router } from 'express';
import { getCheckService } from '../../services/checkService.js';
import logger from '../../utils/loggerUtils.js';

const router = Router();

/**
 * Heartbeat 설정
 */
const HEARTBEAT_INTERVAL_MS = 15000;  // 15초마다 heartbeat
const HEARTBEAT_CHAR = '\n';          // JSON.parse가 무시하는 공백 문자

/**
 * 검사 모드 / 길이 제한
 *
 * SELECTION_MAX_LINES: vLLM 64K 토큰 한도를 코드 분량으로 환산한 보수적 상한.
 *   plugin은 선택 영역을 가장 가까운 메서드 경계로 확장해 보내야 하며,
 *   단일 메서드가 이 한도를 넘는 경우는 거의 없음. 안전장치로만 활용.
 */
const SELECTION_MAX_LINES = 6000;
const VALID_CHECK_MODES = ['file', 'selection', 'auto'];

/**
 * POST /api/check
 * 
 * Java 코드 검사 실행
 * 
 * Request Body:
 * {
 *   code: string,           // Java 소스 코드 (필수)
 *   fileName: string,       // 파일명 (선택, 기본: unknown.java)
 *   options: {
 *     format: string,       // 출력 형식 (json|sarif|github)
 *     forceChunk: boolean,  // 강제 청킹 여부
 *     checkMode: string     // 'file' | 'selection' | 'auto' (기본: 'auto')
 *                           //   file      = 항상 청킹 (파일 전체 검사)
 *                           //   selection = 청킹 안 함 (선택 영역, 단일 메서드 가정)
 *                           //   auto      = 줄 수 기반 자동 판단
 *   }
 * }
 */
router.post('/', async (req, res, next) => {
  let heartbeatTimer = null;
  let heartbeatCount = 0;
  let finished = false;

  try {
    const { code, fileName, options = {} } = req.body;

    // ── 입력 검증 ──
    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_CODE',
        message: 'code 파라미터는 필수입니다.'
      });
    }

    if (code.length > 10 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'CODE_TOO_LARGE',
        message: '코드 크기가 10MB를 초과합니다.'
      });
    }

    const validFormats = ['json', 'sarif', 'github'];
    const format = options.format?.toLowerCase() || 'json';
    if (!validFormats.includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_FORMAT',
        message: `지원하지 않는 형식: ${options.format}. 지원 형식: ${validFormats.join(', ')}`
      });
    }

    // checkMode 검증
    const checkMode = (options.checkMode || 'auto').toLowerCase();
    if (!VALID_CHECK_MODES.includes(checkMode)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_CHECK_MODE',
        message: `지원하지 않는 checkMode: ${options.checkMode}. 지원: ${VALID_CHECK_MODES.join(', ')}`
      });
    }

    // 선택 검사 길이 제한 (vLLM 64K 토큰 보호용)
    if (checkMode === 'selection') {
      const lineCount = code.split('\n').length;
      if (lineCount > SELECTION_MAX_LINES) {
        return res.status(400).json({
          success: false,
          error: 'SELECTION_TOO_LARGE',
          message: `선택 영역이 ${SELECTION_MAX_LINES}줄을 초과합니다 (현재 ${lineCount}줄). ` +
                   `더 작은 범위를 선택하거나 파일 전체 검사를 사용하세요.`
        });
      }
    }

    // ── 서비스 초기화 ──
    const checkService = getCheckService();
    await checkService.initialize();

    // ── Heartbeat 시작 ──
    // Content-Type을 먼저 보내고, 주기적으로 공백을 전송하여 프록시 연결 유지
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Content-Streaming', 'heartbeat');  // 커스텀 헤더: heartbeat 모드 표시
    res.flushHeaders();

    const lineCount = code.split('\n').length;
    logger.info(`[check.routes] 검사 시작: ${fileName || 'unknown.java'} (${lineCount}줄, ${code.length}자) - heartbeat 활성화`);

    heartbeatTimer = setInterval(() => {
      if (finished) return;

      try {
        // 연결이 아직 살아있는지 확인
        if (!res.destroyed && res.writable) {
          res.write(HEARTBEAT_CHAR);
          heartbeatCount++;
          logger.debug(`[check.routes] heartbeat #${heartbeatCount} 전송 (${heartbeatCount * HEARTBEAT_INTERVAL_MS / 1000}초 경과)`);
        } else {
          // 클라이언트가 이미 끊었으면 정리
          logger.warn(`[check.routes] 클라이언트 연결 끊김 감지 (heartbeat #${heartbeatCount})`);
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      } catch (e) {
        logger.warn(`[check.routes] heartbeat 전송 실패: ${e.message}`);
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 클라이언트 연결 끊김 감지
    res.on('close', () => {
      if (!finished) {
        logger.warn(`[check.routes] 클라이언트 연결 종료 (처리 중, heartbeat ${heartbeatCount}회 전송)`);
        finished = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }
    });

    // ── 코드 검사 실행 ──
    const result = await checkService.checkCode(code, fileName || 'unknown.java', {
      format,
      forceChunk: options.forceChunk || false,
      checkMode
    });

    // ── Heartbeat 중지 + 결과 전송 ──
    finished = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (!res.destroyed && res.writable) {
      const jsonStr = JSON.stringify(result);
      logger.info(`[check.routes] 검사 완료: 결과 ${jsonStr.length}자 전송 (heartbeat ${heartbeatCount}회)`);
      res.end(jsonStr);
    } else {
      logger.warn(`[check.routes] 검사 완료했으나 클라이언트 이미 연결 끊김`);
    }

  } catch (error) {
    // ── 에러 처리 ──
    finished = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    logger.error('[check.routes] 검사 실패:', error.message);

    if (res.headersSent) {
      // 이미 heartbeat를 보낸 상태에서 에러 → JSON 에러 응답으로 마무리
      try {
        if (!res.destroyed && res.writable) {
          res.end(JSON.stringify({
            success: false,
            error: 'CHECK_FAILED',
            message: error.message
          }));
        }
      } catch (e) {
        logger.error('[check.routes] 에러 응답 전송 실패:', e.message);
      }
    } else {
      next(error);
    }
  }
});

/**
 * GET /api/check/stats
 */
router.get('/stats', async (req, res, next) => {
  try {
    const checkService = getCheckService();
    await checkService.initialize();
    const stats = checkService.getFilteringStats();
    res.json({ success: true, stats });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/check/stats/reset
 */
router.post('/stats/reset', async (req, res, next) => {
  try {
    const checkService = getCheckService();
    await checkService.initialize();
    checkService.resetFilteringStats();
    res.json({ success: true, message: '통계가 리셋되었습니다.' });
  } catch (error) {
    next(error);
  }
});

export default router;