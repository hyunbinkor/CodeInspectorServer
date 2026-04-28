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
   * @param {string} options.checkMode - 검사 모드 ('file' | 'selection' | 'auto')
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
        outputFormat: outputFormat,
        checkMode: options.checkMode || 'auto'
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
   * 진행 상황 콜백을 지원하는 코드 검사 (SSE 스트리밍용)
   * 
   * @param {string} code - Java 소스 코드
   * @param {string} fileName - 파일명
   * @param {Object} options - 검사 옵션
   * @param {Function} onProgress - 진행 상황 콜백 (progress) => void
   * @returns {Promise<Object>} 검사 결과
   */
  async checkCodeWithProgress(code, fileName = 'unknown.java', options = {}, onProgress = () => {}) {
    await this.ensureInitialized();

    const startTime = Date.now();
    const outputFormat = options.format || 'json';

    logger.info(`[CheckService] 스트리밍 검사 시작: ${fileName} (${code.length}자)`);

    try {
      // codeChecker.checkCode()에 onProgress 콜백 전달
      const result = await this.codeChecker.checkCode(code, fileName, {
        forceChunk: options.forceChunk,
        outputFormat: outputFormat,
        checkMode: options.checkMode || 'auto',
        onProgress: onProgress  // 콜백 전달
      });

      const elapsed = Date.now() - startTime;
      logger.info(`[CheckService] 스트리밍 검사 완료: ${result.issues?.length || 0}개 이슈 (${elapsed}ms)`);

      // 응답 형식 통일
      return this.formatResponse(result, outputFormat, elapsed);

    } catch (error) {
      logger.error(`[CheckService] 스트리밍 검사 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * 응답 형식 통일
   * @private
   */
  formatResponse(result, format, elapsed) {
    const response = {
      success: result.success !== false,
      fileName: result.fileName,
      format: format,
      issues: result.issues || [],
      summary: result.summary || this.buildSummary(result.issues || []),
      processingTimeMs: elapsed
    };

    // 청킹 정보
    if (result.chunked) {
      response.chunked = true;
    }

    // SARIF 형식
    if (format === 'sarif' && result.sarif) {
      response.sarif = result.sarif;
    }

    // GitHub 어노테이션 형식
    if (format === 'github') {
      response.annotations = result.annotations || 
        this.buildGitHubAnnotations(result.issues, result.fileName);
    }

    // 통계
    if (result.stats) {
      response.stats = result.stats;
    }

    return response;
  }

  /**
   * 이슈 요약 생성
   * @private
   */
  buildSummary(issues = []) {
    const bySeverity = {};
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
      const title = this._escapeGitHubProperty(`${issue.title || issue.ruleId} (${issue.ruleId})`);
      const message = this._escapeGitHubMessage(issue.description || issue.message || issue.title || '');

      return `::${level} file=${fileName},line=${line},col=${col},title=${title}::${message}`;
    }).join('\n');
  }

  /**
   * [Fix M3] GitHub Actions workflow command 메시지 이스케이프.
   *   message 본문은 한 줄로 합쳐져야 하므로 줄바꿈은 %0A,
   *   캐리지리턴은 %0D로 인코딩한다.
   *   https://docs.github.com/en/actions/using-workflows/workflow-commands
   * @private
   */
  _escapeGitHubMessage(text) {
    return String(text).replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  }

  /**
   * GitHub workflow command property 이스케이프 (title 등).
   *   ::set-output name=foo::bar 같은 구분자 깨짐 방지를 위해
   *   `,`, `:`도 이스케이프한다.
   * @private
   */
  _escapeGitHubProperty(text) {
    return String(text)
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A')
      .replace(/,/g, '%2C')
      .replace(/:/g, '%3A');
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