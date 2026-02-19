/**
 * 코드 검사 API 라우트
 * 
 * POST /api/check - 코드 검사 실행
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
 * Java 코드 검사 실행
 * 
 * Request Body:
 * {
 *   code: string,           // Java 소스 코드 (필수)
 *   fileName: string,       // 파일명 (선택, 기본: unknown.java)
 *   options: {
 *     format: string,       // 출력 형식 (json|sarif|github)
 *     forceChunk: boolean   // 강제 청킹 여부
 *   }
 * }
 * 
 * Response:
 * {
 *   success: boolean,
 *   fileName: string,
 *   lineCount: number,
 *   chunked: boolean,
 *   processingTimeMs: number,
 *   format: string,
 *   issues: Issue[],
 *   summary: Object,
 *   sarif?: Object,         // format=sarif일 때
 *   annotations?: string    // format=github일 때
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const { code, fileName, options = {} } = req.body;

    // 필수 파라미터 검증
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
