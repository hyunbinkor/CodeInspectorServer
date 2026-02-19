/**
 * 코드 검사 서비스
 * 
 * 기존 codeChecker.js를 API 서비스 레이어로 래핑
 * 
 * @module services/checkService
 */

import { getCodeChecker } from '../core/checker/codeChecker.js';
import { getChunkResultMerger } from '../core/chunker/chunkResultMerger.js';
import logger from '../utils/loggerUtils.js';

// ChunkResultMerger는 현재 checkService에서 직접 사용하지 않음
// codeChecker 내부에서 사용됨

export class CheckService {
  constructor() {
    this.codeChecker = null;
    this.chunkResultMerger = null;
    this.initialized = false;
  }

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    logger.info('🔧 CheckService 초기화 중...');

    this.codeChecker = getCodeChecker();
    await this.codeChecker.initialize();

    this.chunkResultMerger = getChunkResultMerger();

    this.initialized = true;
    logger.info('✅ CheckService 초기화 완료');
  }

  /**
   * 코드 검사 실행
   * 
   * @param {string} code - Java 소스 코드
   * @param {string} fileName - 파일명
   * @param {Object} options - 검사 옵션
   * @param {string} options.format - 출력 형식 (json, sarif, github)
   * @param {boolean} options.forceChunk - 강제 청킹 여부
   * @returns {Promise<Object>} 검사 결과
   */
  async checkCode(code, fileName = 'unknown.java', options = {}) {
    await this.ensureInitialized();

    const startTime = Date.now();
    const outputFormat = options.format || 'json';

    logger.info(`[CheckService] 검사 시작: ${fileName} (${code.length}자)`);

    try {
      // codeChecker.checkCode() 호출
      const result = await this.codeChecker.checkCode(code, fileName, {
        forceChunk: options.forceChunk,
        outputFormat: outputFormat
      });

      const elapsed = Date.now() - startTime;
      logger.info(`[CheckService] 검사 완료: ${result.issues?.length || 0}개 이슈 (${elapsed}ms)`);

      // 응답 형식 통일
      return this.formatResponse(result, outputFormat, elapsed);

    } catch (error) {
      logger.error(`[CheckService] 검사 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * 응답 형식 변환
   * @private
   */
  formatResponse(result, format, elapsed) {
    const baseResponse = {
      success: result.success !== false,
      fileName: result.fileName || result.file?.name,
      lineCount: result.lineCount || result.file?.totalLines,
      chunked: result.chunked || false,
      processingTimeMs: elapsed
    };

    if (format === 'sarif') {
      return {
        ...baseResponse,
        format: 'sarif',
        sarif: result.sarif,
        issues: result.issues,
        summary: result.summary || this.buildSummary(result.issues)
      };
    }

    if (format === 'github') {
      // GitHub Actions 어노테이션 형식
      const annotations = result.annotations || 
        this.buildGitHubAnnotations(result.issues, baseResponse.fileName);

      return {
        ...baseResponse,
        format: 'github',
        annotations,
        issues: result.issues,
        summary: result.summary || this.buildSummary(result.issues)
      };
    }

    // 기본 JSON 형식
    return {
      ...baseResponse,
      format: 'json',
      issues: result.issues || [],
      summary: result.summary || this.buildSummary(result.issues),
      tags: result.tags || [],
      matchedRulesCount: result.matchedRulesCount || 0,
      stats: result.stats || {}
    };
  }

  /**
   * 요약 생성
   * @private
   */
  buildSummary(issues = []) {
    const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const byCategory = {};

    for (const issue of issues) {
      const severity = issue.severity || 'MEDIUM';
      bySeverity[severity] = (bySeverity[severity] || 0) + 1;

      const category = issue.category || 'general';
      byCategory[category] = (byCategory[category] || 0) + 1;
    }

    return {
      totalIssues: issues.length,
      bySeverity,
      byCategory
    };
  }

  /**
   * GitHub 어노테이션 생성
   * @private
   */
  buildGitHubAnnotations(issues = [], fileName = 'unknown') {
    return issues.map(issue => {
      const level = this.severityToGitHubLevel(issue.severity);
      const line = issue.line || 1;
      const col = issue.column || 1;
      const title = `${issue.title || issue.ruleId} (${issue.ruleId})`;
      const message = issue.description || issue.message || issue.title;

      return `::${level} file=${fileName},line=${line},col=${col},title=${title}::${message}`;
    }).join('\n');
  }

  /**
   * 심각도 → GitHub 레벨 변환
   * @private
   */
  severityToGitHubLevel(severity) {
    const mapping = {
      'CRITICAL': 'error',
      'HIGH': 'error',
      'MEDIUM': 'warning',
      'LOW': 'notice',
      'INFO': 'notice'
    };
    return mapping[severity] || 'warning';
  }

  /**
   * 필터링 통계 조회
   */
  getFilteringStats() {
    if (this.codeChecker) {
      return this.codeChecker.getFilteringStats();
    }
    return null;
  }

  /**
   * 필터링 통계 리셋
   */
  resetFilteringStats() {
    if (this.codeChecker) {
      this.codeChecker.resetFilteringStats();
    }
  }

  /**
   * 초기화 확인
   * @private
   */
  async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

// 싱글톤
let instance = null;

export function getCheckService() {
  if (!instance) {
    instance = new CheckService();
  }
  return instance;
}

export function resetCheckService() {
  instance = null;
}

export default CheckService;
