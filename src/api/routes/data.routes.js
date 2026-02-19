/**
 * 데이터 동기화 API 라우트
 * 
 * GET  /api/data/pull  - 전체 데이터 다운로드
 * POST /api/data/diff  - 변경사항 미리보기
 * POST /api/data/push  - 전체 데이터 업로드
 * GET  /api/data/stats - 통계 조회
 * 
 * @module api/routes/data.routes
 */

import { Router } from 'express';
import { getDataService } from '../../services/dataService.js';
import logger from '../../utils/loggerUtils.js';

const router = Router();

/**
 * GET /api/data/pull
 * 
 * 전체 규칙/태그 데이터 다운로드
 * 
 * Response:
 * {
 *   version: number,        // 데이터 버전 (타임스탬프)
 *   pulledAt: string,       // Pull 시각
 *   rules: {
 *     count: number,
 *     items: Rule[]
 *   },
 *   tags: Object,           // 태그 정의 전체
 *   metadata: {
 *     ruleCount: number,
 *     tagCount: number,
 *     compoundTagCount: number
 *   }
 * }
 */
router.get('/pull', async (req, res, next) => {
  try {
    logger.info('[data.routes] Pull 요청');

    const dataService = getDataService();
    await dataService.initialize();

    const result = await dataService.pull();

    res.json(result);

  } catch (error) {
    logger.error('[data.routes] Pull 실패:', error.message);
    next(error);
  }
});

/**
 * POST /api/data/diff
 * 
 * 로컬 데이터와 서버 데이터 비교
 * 
 * Request Body:
 * {
 *   baseVersion: number,    // Pull 시 받은 버전
 *   rules: Rule[],          // 로컬 규칙 배열
 *   tags: Object            // 로컬 태그 정의
 * }
 * 
 * Response:
 * {
 *   baseVersion: number,
 *   currentVersion: number,
 *   hasConflict: boolean,
 *   rules: {
 *     added: Object[],
 *     modified: Object[],
 *     deleted: Object[],
 *     unchanged: string[],
 *     summary: Object
 *   },
 *   tags: {
 *     added: Object[],
 *     modified: Object[],
 *     deleted: Object[],
 *     unchanged: string[],
 *     summary: Object
 *   }
 * }
 */
router.post('/diff', async (req, res, next) => {
  try {
    const { baseVersion, rules, tags } = req.body;

    logger.info(`[data.routes] Diff 요청: 규칙 ${rules?.length || 0}개`);

    const dataService = getDataService();
    await dataService.initialize();

    const result = await dataService.diff({
      baseVersion,
      rules: rules || [],
      tags: tags || {}
    });

    res.json(result);

  } catch (error) {
    logger.error('[data.routes] Diff 실패:', error.message);
    next(error);
  }
});

/**
 * POST /api/data/push
 * 
 * 전체 데이터 업로드 (자동 백업 후 교체)
 * 
 * Request Body:
 * {
 *   baseVersion: number,    // Pull 시 받은 버전 (충돌 감지용)
 *   rules: Rule[],          // 업로드할 규칙 배열
 *   tags: Object,           // 업로드할 태그 정의
 *   force: boolean          // 버전 충돌 시 강제 덮어쓰기
 * }
 * 
 * Response (성공):
 * {
 *   success: true,
 *   newVersion: number,
 *   pushedAt: string,
 *   backupPath: string,
 *   rules: { total, success, failed },
 *   tags: { total }
 * }
 * 
 * Response (충돌):
 * {
 *   success: false,
 *   error: 'VERSION_CONFLICT',
 *   message: string,
 *   baseVersion: number,
 *   currentVersion: number
 * }
 */
router.post('/push', async (req, res, next) => {
  try {
    const { baseVersion, rules, tags, force } = req.body;

    // 규칙 배열 필수
    if (!rules || !Array.isArray(rules)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_DATA',
        message: 'rules는 배열이어야 합니다.'
      });
    }

    logger.info(`[data.routes] Push 요청: 규칙 ${rules.length}개, force=${force}`);

    const dataService = getDataService();
    await dataService.initialize();

    const result = await dataService.push({
      baseVersion,
      rules,
      tags: tags || {},
      force: force || false
    });

    // 버전 충돌인 경우 409 반환
    if (!result.success && result.error === 'VERSION_CONFLICT') {
      return res.status(409).json(result);
    }

    res.json(result);

  } catch (error) {
    logger.error('[data.routes] Push 실패:', error.message);
    next(error);
  }
});

/**
 * GET /api/data/stats
 * 
 * 데이터 통계 조회
 * 
 * Response:
 * {
 *   rules: { count, status },
 *   tags: { count, compoundCount, categories }
 * }
 */
router.get('/stats', async (req, res, next) => {
  try {
    const dataService = getDataService();
    await dataService.initialize();

    const stats = await dataService.getStats();

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    logger.error('[data.routes] Stats 조회 실패:', error.message);
    next(error);
  }
});

export default router;
