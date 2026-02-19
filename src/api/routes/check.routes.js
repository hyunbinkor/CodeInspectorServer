/**
 * 코드 검사 라우트
 * 
 * POST /api/check         - 기존 코드 검사 (동기)
 * POST /api/check/stream   - SSE 스트리밍 코드 검사
 * GET  /api/check/stats    - 필터링 통계 조회
 * POST /api/check/stats/reset - 필터링 통계 리셋
 * 
 * @module api/routes/check.routes
 */

import { Router } from 'express';
import { getCheckService } from '../../services/checkService.js';
import logger from '../../utils/loggerUtils.js';

const router = Router();

/**
 * POST /api/check
 * 
 * 기존 동기 방식 코드 검사 (변경 없음)
 */
router.post('/', async (req, res, next) => {
  try {
    const { code, fileName, options = {} } = req.body;

    // 입력 검증
    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_CODE',
        message: 'code 파라미터는 필수입니다.'
      });
    }

    // 코드 크기 제한 (10MB)
    if (code.length > 10 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'CODE_TOO_LARGE',
        message: '코드 크기가 10MB를 초과합니다.'
      });
    }

    // 출력 형식 검증
    const validFormats = ['json', 'sarif', 'github'];
    const format = options.format?.toLowerCase() || 'json';
    if (!validFormats.includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_FORMAT',
        message: `지원하지 않는 형식: ${options.format}. 지원 형식: ${validFormats.join(', ')}`
      });
    }

    const checkService = getCheckService();
    await checkService.initialize();

    // 헤더 먼저 전송 (연결 유지 신호)
    res.setHeader('Content-Type', 'application/json');
    res.flushHeaders();

    const result = await checkService.checkCode(code, fileName || 'unknown.java', {
      format,
      forceChunk: options.forceChunk || false
    });

    res.end(JSON.stringify(result));

  } catch (error) {
    logger.error('[check.routes] 검사 실패:', error.message);
    
    // 헤더 이미 보낸 후 에러면 직접 응답
    if (res.headersSent) {
      res.end(JSON.stringify({
        success: false,
        error: 'CHECK_FAILED',
        message: error.message
      }));
    } else {
      next(error);
    }
  }
});

/**
 * POST /api/check/stream
 * 
 * SSE 스트리밍 방식의 코드 검사
 * OpenShift 타임아웃 문제 해결을 위해 진행 상황을 실시간 전송
 * 
 * Request Body: (기존 /api/check와 동일)
 * {
 *   code: string,
 *   fileName: string,
 *   options: { format, forceChunk }
 * }
 * 
 * Response: SSE 이벤트 스트림
 * - event: progress - 진행 상황 업데이트
 * - event: complete - 최종 결과
 * - event: error - 에러 발생
 */
router.post('/stream', async (req, res) => {
  // 1. SSE 헤더 설정
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx/OpenShift 버퍼링 비활성화
  res.flushHeaders();

  // 2. SSE 이벤트 전송 헬퍼
  const sendEvent = (eventType, data) => {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 3. 연결 종료 감지
  let isConnectionClosed = false;
  req.on('close', () => {
    isConnectionClosed = true;
    logger.info('[check.routes] 클라이언트 연결 종료');
  });

  // 4. 진행 상황 콜백
  const onProgress = (progress) => {
    if (!isConnectionClosed) {
      sendEvent('progress', progress);
    }
  };

  try {
    const { code, fileName, options = {} } = req.body;

    // 입력 검증
    if (!code) {
      sendEvent('error', {
        error: 'MISSING_CODE',
        message: 'code 파라미터는 필수입니다.'
      });
      return res.end();
    }

    if (code.length > 10 * 1024 * 1024) {
      sendEvent('error', {
        error: 'CODE_TOO_LARGE',
        message: '코드 크기가 10MB를 초과합니다.'
      });
      return res.end();
    }

    const validFormats = ['json', 'sarif', 'github'];
    const format = options.format?.toLowerCase() || 'json';
    if (!validFormats.includes(format)) {
      sendEvent('error', {
        error: 'INVALID_FORMAT',
        message: `지원하지 않는 형식: ${options.format}`
      });
      return res.end();
    }

    // 서비스 초기화 및 검사 실행
    const checkService = getCheckService();
    await checkService.initialize();

    const result = await checkService.checkCodeWithProgress(
      code,
      fileName || 'unknown.java',
      { format, forceChunk: options.forceChunk || false },
      onProgress
    );

    // 최종 결과 전송
    if (!isConnectionClosed) {
      sendEvent('complete', result);
    }
    res.end();

  } catch (error) {
    logger.error('[check.routes] 스트리밍 검사 실패:', error.message);

    if (!isConnectionClosed) {
      sendEvent('error', {
        error: 'CHECK_FAILED',
        message: error.message
      });
    }
    res.end();
  }
});

/**
 * GET /api/check/stats
 * 
 * 필터링 통계 조회
 */
router.get('/stats', async (req, res, next) => {
  try {
    const checkService = getCheckService();
    await checkService.initialize();

    const stats = checkService.getFilteringStats();

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/check/stats/reset
 * 
 * 필터링 통계 리셋
 */
router.post('/stats/reset', async (req, res, next) => {
  try {
    const checkService = getCheckService();
    await checkService.initialize();

    checkService.resetFilteringStats();

    res.json({
      success: true,
      message: '통계가 리셋되었습니다.'
    });

  } catch (error) {
    next(error);
  }
});

export default router;