/**
 * Java 코드 품질 검사 API 서버
 * 
 * Express 기반 REST API 서버
 * 
 * @module app
 */

import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import checkRoutes from './api/routes/check.routes.js';
import dataRoutes from './api/routes/data.routes.js';
import { 
  errorHandler, 
  notFoundHandler, 
  requestLogger,
  jsonParseErrorHandler 
} from './api/middlewares/errorHandler.js';
import logger from './utils/loggerUtils.js';

// Express 앱 생성
const app = express();

// ═══════════════════════════════════════════════════════════════════════════
// 미들웨어 설정
// ═══════════════════════════════════════════════════════════════════════════

// CORS 설정
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON 바디 파서 (10MB 제한)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// JSON 파싱 에러 핸들러
app.use(jsonParseErrorHandler);

// 요청 로깅
app.use(requestLogger);

// ═══════════════════════════════════════════════════════════════════════════
// API 라우트
// ═══════════════════════════════════════════════════════════════════════════

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API 라우트 마운트
app.use('/api/check', checkRoutes);
app.use('/api/data', dataRoutes);

// API 정보
app.get('/api', (req, res) => {
  res.json({
    name: 'Code Quality API',
    version: '1.0.0',
    endpoints: {
      check: {
        'POST /api/check': '코드 검사 실행',
        'GET /api/check/stats': '필터링 통계 조회',
        'POST /api/check/stats/reset': '통계 리셋'
      },
      data: {
        'GET /api/data/pull': '전체 데이터 다운로드',
        'POST /api/data/diff': '변경사항 미리보기',
        'POST /api/data/push': '전체 데이터 업로드',
        'GET /api/data/stats': '데이터 통계 조회'
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 에러 핸들링
// ═══════════════════════════════════════════════════════════════════════════

// 404 핸들러
app.use(notFoundHandler);

// 글로벌 에러 핸들러
app.use(errorHandler);

// ═══════════════════════════════════════════════════════════════════════════
// 서버 시작
// ═══════════════════════════════════════════════════════════════════════════

const PORT = config.server.port;
const HOST = config.server.host;

app.listen(PORT, HOST, () => {
  console.log('\n' + '═'.repeat(60));
  console.log('🚀 Java 코드 품질 검사 API 서버');
  console.log('═'.repeat(60));
  console.log(`
  서버 주소:  http://${HOST}:${PORT}
  환경:       ${config.server.env}
  
  API 엔드포인트:
    POST /api/check          코드 검사
    GET  /api/data/pull      데이터 다운로드
    POST /api/data/diff      변경사항 미리보기
    POST /api/data/push      데이터 업로드
  
  헬스 체크:
    GET  /health
  
  API 문서:
    GET  /api
  `);
  console.log('═'.repeat(60) + '\n');
  
  logger.info(`서버 시작: http://${HOST}:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM 수신, 서버 종료 중...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT 수신, 서버 종료 중...');
  process.exit(0);
});

export default app;
