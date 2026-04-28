/**
 * 에러 핸들러 미들웨어
 * 
 * @module api/middlewares/errorHandler
 */

import logger from '../../utils/loggerUtils.js';

/**
 * 404 Not Found 핸들러
 */
export function notFoundHandler(req, res, _next) {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `경로를 찾을 수 없습니다: ${req.method} ${req.path}`
  });
}

/**
 * 글로벌 에러 핸들러
 */
// Express는 4-arg 시그니처로 에러 핸들러를 인식하므로 _next는 시그니처상 필수
// (실제 호출은 안 하지만 인자 위치를 비울 수 없음)
export function errorHandler(err, req, res, _next) {
  // 에러 로깅
  logger.error('에러 발생:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  // 클라이언트 응답
  const statusCode = err.statusCode || 500;
  const response = {
    success: false,
    error: err.code || 'INTERNAL_ERROR',
    message: err.message || '내부 서버 오류가 발생했습니다.'
  };

  // 개발 환경에서는 스택 트레이스 포함
  if (process.env.NODE_ENV !== 'production') {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

/**
 * 요청 로깅 미들웨어
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logLevel = res.statusCode >= 400 ? 'warn' : 'info';
    
    logger[logLevel](`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  
  next();
}

/**
 * JSON 파싱 에러 핸들러
 */
export function jsonParseErrorHandler(err, req, res, next) {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_JSON',
      message: 'JSON 파싱 오류: ' + err.message
    });
  }
  next(err);
}

export default {
  notFoundHandler,
  errorHandler,
  requestLogger,
  jsonParseErrorHandler
};
