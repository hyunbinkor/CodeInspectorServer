/**
 * 코드 점검기 (통합 버전)
 *
 * 기존 프로젝트의 DevelopmentGuidelineChecker.js 핵심 로직 통합
 * - v4.0 checkType 기반 단계적 필터링
 * - pure_regex     : 정규식만으로 판정 (LLM 스킵)
 * - llm_with_regex : 정규식 후보 → LLM 검증
 * - llm_contextual : 태그/키워드 필터 → LLM 분석
 * - llm_with_ast   : AST 정보 + LLM 검증
 * - 3000줄 이상 자동 청킹 지원
 *
 * 변경사항:
 * - [Fix] checkCodeDirect(): limit 50 → 200, tags 누락 인수 추가
 * - [Fix] checkCodeChunked(): chunk.code만 전송, 클래스명은 chunkContext로 별도 전달
 * - [Fix] verifyWithLLM(): chunkContext를 buildSingleRulePrompt까지 전달
 * - [Fix] buildSingleRulePrompt(): chunkContext 섹션 추가, 프롬프트 문구 수정
 * - [Fix] truncateCode(): 100000자 한도, 주석코드 제거, 후보 라인 기반 거리 제거
 * - [Fix] checkCode(): checkMode 기반 청킹 결정 (file=무조건 청킹, selection=청킹 안 함)
 * - [Fix #1] Repository 패턴 사용 — 가이드라인 + 이슈 컬렉션 모두 조회
 * - [Fix #2] matchesContextualCondition: 조건 없는 규칙 통과
 * - [Fix #3] llm_with_regex antiPatterns 없을 때 llm_contextual 폴백
 * - [Fix #4] limit 200 → 10000
 * - [Fix #10] filteringStats를 checkCode 진입 시 리셋 (요청별 스코프)
 * - [Fix #11] scoreThreshold 파라미터 제거 (scroll API에서 무의미)
 *
 * @module checker/codeChecker
 */

import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { getCodeTagger }    from '../tagger/codeTagger.js';
import { getQdrantClient }  from '../clients/qdrantClient.js';
import { getLLMClient }     from '../clients/llmClient.js';
import { getJavaAstParser } from '../ast/javaAstParser.js';
import { getResultBuilder } from './resultBuilder.js';
import { MethodChunker }    from '../chunker/methodChunker.js';
import { ChunkResultMerger } from '../chunker/chunkResultMerger.js';
import { getQdrantRuleRepository } from '../../repositories/impl/QdrantRuleRepository.js';  // [Fix #1] Repository 추가
import { listFiles, readTextFile, writeJsonFile } from '../../utils/fileUtils.js';
import { createRegexSafe }  from '../../utils/regexUtils.js';
import { config }           from '../../config/index.js';
import logger               from '../../utils/loggerUtils.js';

const CHECK_TYPES = {
  PURE_REGEX:    'pure_regex',
  LLM_WITH_REGEX: 'llm_with_regex',
  LLM_CONTEXTUAL: 'llm_contextual',
  LLM_WITH_AST:   'llm_with_ast'
};

// [Fix C3] 요청별 stats 격리용 비동기 컨텍스트.
//   동시 검사 요청이 싱글톤 CodeChecker.filteringStats를 서로 덮어써
//   응답의 stats.llmCalls가 다른 요청 값으로 보고되던 문제를 해결.
//   각 checkCode 진입 시 store에 빈 stats를 push, 모든 increment는
//   _getStats()를 거쳐 store의 stats를 변경.
const requestStorage = new AsyncLocalStorage();

export class CodeChecker {
  constructor() {
    this.codeTagger        = null;
    this.qdrantClient      = null;
    this.ruleRepository    = null;   // [Fix #1] Repository 추가
    this.llmClient         = null;
    this.astParser         = null;
    this.resultBuilder     = null;
    this.methodChunker     = null;
    this.chunkResultMerger = null;
    this.initialized       = false;

    this.chunkingConfig = {
      autoChunkThreshold: 3000,
      warnThreshold:      3000,
      hardLimit:          15000
    };

    this.validCheckTypes = ['pure_regex', 'llm_with_regex', 'llm_contextual', 'llm_with_ast'];

    // 누적 stats — /api/check/stats 엔드포인트 호환용. 직접 변경하지 않고
    // 매 요청 종료 시 _mergeStatsToGlobal()로 합산만 한다.
    this.filteringStats = this._createEmptyStats();
  }

  /**
   * 빈 stats 객체 생성
   * @private
   */
  _createEmptyStats() {
    return {
      totalChecks:            0,
      pureRegexViolations:    0,
      llmCandidates:          0,
      llmCalls:               0,
      falsePositivesFiltered: 0
    };
  }

  /**
   * 현재 요청 컨텍스트의 stats를 반환. 컨텍스트 밖에서 호출 시
   * 전역 stats로 폴백 (legacy code path 호환).
   * @private
   */
  _getStats() {
    const store = requestStorage.getStore();
    return store?.stats || this.filteringStats;
  }

  /**
   * 요청별 stats를 전역 누적치에 합산
   * @private
   */
  _mergeStatsToGlobal(stats) {
    for (const [key, value] of Object.entries(stats)) {
      this.filteringStats[key] = (this.filteringStats[key] || 0) + value;
    }
  }

  async initialize() {
    if (this.initialized) return;

    logger.info('🔧 CodeChecker 초기화 중...');

    this.codeTagger = getCodeTagger();
    await this.codeTagger.initialize();

    this.qdrantClient = getQdrantClient();
    await this.qdrantClient.initialize();

    // [Fix #1] Repository 초기화 (가이드라인 + 이슈 컬렉션 병합 조회용)
    this.ruleRepository = getQdrantRuleRepository();
    await this.ruleRepository.initialize();

    this.llmClient = getLLMClient();
    await this.llmClient.initialize();

    this.astParser     = getJavaAstParser();
    this.resultBuilder = getResultBuilder();

    this.methodChunker     = new MethodChunker(this.chunkingConfig);
    this.chunkResultMerger = new ChunkResultMerger();

    this.initialized = true;
    logger.info('✅ CodeChecker 초기화 완료');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 메인 점검 메서드
  // ═══════════════════════════════════════════════════════════════════════════

  async checkAll() {
    const inputDir = config.paths.input.code;
    const files    = await listFiles(inputDir, '.java');

    if (files.length === 0) {
      logger.warn(`Java 파일 없음: ${inputDir}`);
      return { reports: [], files: 0 };
    }

    logger.info(`${files.length}개 Java 파일 발견`);
    const allReports = [];

    for (const filePath of files) {
      const report = await this.checkFile(filePath);
      allReports.push(report);
    }

    const summary    = this.resultBuilder.buildSummary(allReports);
    const outputPath = path.join(
      config.paths.output.reports,
      `check_${Date.now()}.json`
    );
    await writeJsonFile(outputPath, {
      checkedAt: new Date().toISOString(),
      summary,
      reports:   allReports,
      stats:     this.filteringStats
    });

    logger.info(`점검 완료: ${allReports.length}개 파일`);
    logger.info(`총 이슈: ${summary.totalIssues}개`);

    return { reports: allReports, summary, files: files.length, outputPath, stats: this.filteringStats };
  }

  async checkFile(filePath) {
    const fileName = path.basename(filePath);
    logger.info(`점검: ${fileName}`);
    try {
      const code   = await readTextFile(filePath);
      const result = await this.checkCode(code, fileName);
      return { file: fileName, path: filePath, ...result };
    } catch (error) {
      logger.error(`파일 점검 실패: ${fileName}`, error.message);
      return { file: fileName, path: filePath, success: false, error: error.message, tags: [], issues: [] };
    }
  }

  /**
   * 코드 점검 메인 (일반 모드 / 청킹 모드 자동 분기)
   */
  async checkCode(code, fileName = 'unknown', options = {}) {
    // [Fix C3] 요청별 stats를 AsyncLocalStorage로 격리.
    //   기존 [Fix #10]은 진입 시 전역 reset → 동시 요청 간 race 발생.
    //   이제 각 요청은 자체 stats를 들고 다니고, 마무리 시 전역에 합산만 한다.
    const stats = this._createEmptyStats();
    return await requestStorage.run({ stats }, async () => {
      try {
        return await this._checkCodeInner(code, fileName, options);
      } finally {
        this._mergeStatsToGlobal(stats);
      }
    });
  }

  async _checkCodeInner(code, fileName, options) {
    const startTime  = Date.now();
    const onProgress = options.onProgress || (() => {});
    const lineCount  = code.split('\n').length;

    // ✅ [Fix] checkMode 기반 청킹 결정
    // file      = 무조건 청킹 (파일 전체 검사)
    // selection = 청킹 안 함 (선택 영역 검사)
    // auto      = 기존 로직 (줄 수 기반 자동 판단)
    const checkMode = options.checkMode || 'auto';
    const needsChunking = checkMode === 'file'      ? true
                        : checkMode === 'selection'  ? false
                        : options.forceChunk || this.methodChunker.needsChunking(code);

    onProgress({ stage: 'start', fileName, lineCount, chunked: needsChunking, timestamp: Date.now() });

    if (needsChunking) {
      logger.info(`[${fileName}] 대용량 파일 (${lineCount}줄) - 청킹 모드 활성화`);
      return this.checkCodeChunked(code, fileName, options);
    }

    // ─── 일반 모드 ────────────────────────────────────────────────────────
    this._getStats().totalChecks++;

    logger.debug(`[${fileName}] 태깅 시작...`);
    const taggingResult = await this.codeTagger.extractTags(code, { useLLM: false });
    const tags          = taggingResult.tags;
    logger.info(`[${fileName}] 태그 ${tags.length}개: ${tags.slice(0, 5).join(', ')}...`);

    onProgress({ stage: 'tagging', status: 'done', tagCount: tags.length, elapsed: Date.now() - startTime });

    const astResult   = this.astParser.parseJavaCode(code);
    const astAnalysis = astResult.analysis;

    logger.debug(`[${fileName}] 룰 조회...`);
    // [Fix #1] Repository 사용 — 가이드라인 + 이슈 컬렉션 모두 조회
    // [Fix #11] scoreThreshold 제거 — scroll API는 벡터 유사도 검색이 아닌 필터 기반 전수 조회이므로 무의미
    const matchedRules = await this.ruleRepository.findByTags(tags, { limit: 10000 });
    logger.info(`[${fileName}] 매칭 룰: ${matchedRules.length}개`);

    onProgress({ stage: 'rules', status: 'done', matchedRules: matchedRules.length, elapsed: Date.now() - startTime });

    if (matchedRules.length === 0) {
      const report = this.resultBuilder.buildReport({ fileName, code, tags, matchedRules: [], issues: [], duration: Date.now() - startTime });
      return report;
    }

    const filterResult = this.preFilterRules(code, astAnalysis, matchedRules, tags);

    onProgress({
      stage:            'filtering',
      status:           'done',
      pureRegexIssues:  filterResult.pureRegexViolations.length,
      llmCandidates:    filterResult.llmCandidates.total,
      elapsed:          Date.now() - startTime
    });

    const issues = [...filterResult.pureRegexViolations];

    if (filterResult.llmCandidates.total > 0) {
      const llmViolations = await this.verifyWithLLM(
        code, astAnalysis, filterResult.llmCandidates, fileName, tags, onProgress
      );
      issues.push(...llmViolations);
    }

    const uniqueIssues = this.deduplicateViolations(issues);

    const report = this.resultBuilder.buildReport({
      fileName,
      code,
      tags,
      matchedRules,
      issues:   uniqueIssues,
      duration: Date.now() - startTime
    });

    logger.info(`[${fileName}] 이슈 ${uniqueIssues.length}개 발견 (${Date.now() - startTime}ms)`);
    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 청킹 모드
  // ═══════════════════════════════════════════════════════════════════════════

  async checkCodeChunked(code, fileName, options = {}) {
    const startTime    = Date.now();
    const outputFormat = options.outputFormat || 'sarif';
    const onProgress   = options.onProgress || (() => {});

    logger.info(`[${fileName}] 🔪 청킹 시작...`);

    // [Fix C1] 원본 코드 전체로 1회 태깅 → globalTags 추출.
    //   청킹 진입 시 각 청크는 메서드 본문만 받으므로 클래스 레벨 정보
    //   (@Service, class XXX extends BaseDAO 등)가 떨어져 나가
    //   IS_DAO/IS_SERVICE 등의 태그가 안 붙는 문제가 있었다.
    //   각 청크 검사 시 globalTags ∪ localTags로 규칙을 조회하도록 한다.
    const globalTaggingResult = await this.codeTagger.extractTags(code, { useLLM: false });
    const globalTags = globalTaggingResult.tags;
    logger.info(`[${fileName}] global 태그 ${globalTags.length}개 추출: ${globalTags.slice(0, 8).join(', ')}${globalTags.length > 8 ? ', ...' : ''}`);

    const chunkingResult = this.methodChunker.chunk(code, { fileName });
    const { chunks, metadata: chunkMeta } = chunkingResult;

    logger.info(`[${fileName}] ${chunkMeta.totalChunks}개 청크 생성 (${chunkMeta.totalMethods}개 메서드)`);

    onProgress({
      stage:        'chunking',
      status:       'done',
      totalChunks:  chunkMeta.totalChunks,
      totalMethods: chunkMeta.totalMethods,
      globalTagCount: globalTags.length,
      elapsed:      Date.now() - startTime
    });

    const chunkResults = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      if (chunk.type === 'header' || chunk.type === 'footer') {
        logger.debug(`[${fileName}] 청크 ${i + 1}/${chunks.length} [${chunk.type}] 스킵`);
        chunkResults.push({ chunkIndex: chunk.index, issues: [], processingTime: 0, llmCalls: 0 });
        continue;
      }

      const chunkStartTime = Date.now();

      onProgress({
        stage:       'chunk_start',
        chunkIndex:  i + 1,
        chunkTotal:  chunks.length,
        methodName:  chunk.methodName || `chunk_${i + 1}`,
        lineRange:   chunk.lineRange  || null
      });

      logger.info(`[${fileName}] 청크 ${i + 1}/${chunks.length} [${chunk.methodName}] 검사 중...`);

      try {
        // ✅ [Fix] 메서드 코드만 전송, 클래스명만 chunkContext로 별도 전달 (import 제외)
        const chunkCode = chunk.code;

        const result = await this.checkCodeDirect(chunkCode, fileName, {
          onProgress: (event) => onProgress({ ...event, stage: 'chunk_llm' }),
          chunkContext: {
            className: chunk.className
          },
          // [Fix C1] global 태그를 청크 검사에 전달하여 클래스 레벨 규칙도 매칭되게 함
          globalTags
        });

        chunkResults.push({
          chunkIndex:     chunk.index,
          issues:         result.issues || [],
          processingTime: Date.now() - chunkStartTime,
          llmCalls:       result.stats?.llmCalls || 0
        });

        onProgress({
          stage:       'chunk_done',
          chunkIndex:  i + 1,
          chunkTotal:  chunks.length,
          methodName:  chunk.methodName,
          issuesFound: result.issues?.length || 0,
          elapsed:     Date.now() - chunkStartTime
        });

      } catch (error) {
        logger.error(`[${fileName}] 청크 ${i + 1} 검사 실패: ${error.message}`);
        chunkResults.push({ chunkIndex: chunk.index, issues: [], processingTime: 0, llmCalls: 0 });
      }
    }

    const totalElapsed = Date.now() - startTime;
    logger.info(`[${fileName}] 청킹 검사 완료 (${totalElapsed}ms)`);

    const mergedResult = this.chunkResultMerger.merge(chunkResults, chunkingResult, options);

    if (outputFormat === 'sarif') {
      const sarif = this.chunkResultMerger.toSARIF(mergedResult, options);
      return {
        success: true, chunked: true, format: 'sarif',
        sarif,
        issues:  mergedResult.issues,
        summary: mergedResult.summary,
        stats: {
          ...this._getStats(),
          processingTime:  totalElapsed,
          chunksProcessed: mergedResult.processing.processedChunks,
          totalChunks:     mergedResult.processing.totalChunks
        }
      };
    } else if (outputFormat === 'github') {
      const annotations = this.chunkResultMerger.toGitHubAnnotations(mergedResult);
      return {
        success: true, chunked: true, format: 'github',
        annotations,
        issues:  mergedResult.issues,
        summary: mergedResult.summary,
        stats:   { ...this._getStats(), processingTime: totalElapsed }
      };
    } else {
      const simple = this.chunkResultMerger.toSimpleJSON(mergedResult);
      return {
        success: true, chunked: true, format: 'json',
        ...simple,
        stats: { ...this._getStats(), processingTime: totalElapsed }
      };
    }
  }

  /**
   * 직접 코드 검사 (청킹 없이 — 개별 청크 검사에 사용)
   */
  async checkCodeDirect(code, fileName, options = {}) {
    const startTime  = Date.now();
    const onProgress = options.onProgress || (() => {});
    this._getStats().totalChecks++;

    // Step 1: 코드 태깅 (local — 청크 코드 자체에서 추출)
    const taggingResult = await this.codeTagger.extractTags(code, { useLLM: false });
    const localTags     = taggingResult.tags;

    // [Fix C1] global 태그(파일 전체 기준)와 병합.
    //   청킹 모드에서만 options.globalTags가 전달됨. 일반 호출 시 빈 배열.
    //   클래스 레벨 태그(IS_DAO, IS_SERVICE, EXTENDS_BASE_*)는 메서드 본문만으로
    //   추출 불가하므로 global에서 보충. 중복은 Set으로 자연 제거.
    const globalTags = options.globalTags || [];
    const tags = [...new Set([...globalTags, ...localTags])];

    // Step 2: AST 분석
    const astResult   = this.astParser.parseJavaCode(code);
    const astAnalysis = astResult.analysis;

    // Step 3: 태그 기반 룰 조회
    // [Fix #1] Repository 사용 — 가이드라인 + 이슈 컬렉션 모두 조회
    // [Fix #11] scoreThreshold 제거 — scroll API는 필터 기반 전수 조회
    const matchedRules = await this.ruleRepository.findByTags(tags, {
      limit: 10000
    });

    if (matchedRules.length === 0) {
      return { success: true, issues: [], stats: { llmCalls: 0 } };
    }

    // Step 4: 사전 필터링
    // [Fix] tags 인수 추가 (기존 누락으로 llm_contextual 규칙이 전부 스킵됨)
    const filterResult = this.preFilterRules(code, astAnalysis, matchedRules, tags);

    // Step 5: pure_regex 위반 수집
    const issues = [...filterResult.pureRegexViolations];

    // Step 6: LLM 검증
    // ✅ [Fix] options를 verifyWithLLM에 전달하여 chunkContext가 프롬프트까지 도달
    if (filterResult.llmCandidates.total > 0) {
      const llmViolations = await this.verifyWithLLM(
        code, astAnalysis, filterResult.llmCandidates, fileName, tags, onProgress, options
      );
      issues.push(...llmViolations);
    }

    // Step 7: 중복 제거
    const uniqueIssues = this.deduplicateViolations(issues);

    return {
      success: true,
      issues:  uniqueIssues,
      stats:   { llmCalls: this._getStats().llmCalls, llmCandidates: filterResult.llmCandidates.total }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // v4.0 사전 필터링
  // ═══════════════════════════════════════════════════════════════════════════

  preFilterRules(sourceCode, astAnalysis, rules, tags) {
    const pureRegexViolations = [];
    const llmCandidates = {
      llm_with_regex: [],
      llm_contextual: [],
      llm_with_ast:   [],
      total:          0
    };

    const tagSet = new Set(tags);

    for (const rule of rules) {
      const checkType = rule.checkType || 'llm_contextual';

      switch (checkType) {
        case 'pure_regex': {
          const regexResult = this.checkPureRegex(sourceCode, rule);
          if (regexResult.violations.length > 0) {
            pureRegexViolations.push(...regexResult.violations);
          }
          break;
        }
        case 'llm_with_regex': {
          const candidates = this.findRegexCandidates(sourceCode, rule);
          if (candidates.length > 0) {
            llmCandidates.llm_with_regex.push({ rule, candidates });
            llmCandidates.total += 1;
          } else if (!rule.antiPatterns || rule.antiPatterns.length === 0) {
            // [Fix #3] antiPatterns 없거나 파싱 실패 → llm_contextual로 폴백
            logger.info(`[preFilter] ${rule.ruleId}: llm_with_regex → llm_contextual 폴백 (antiPatterns 없음/파싱실패)`);
            if (this.matchesContextualCondition(sourceCode, rule, tagSet)) {
              llmCandidates.llm_contextual.push({ rule });
              llmCandidates.total += 1;
            }
          }
          break;
        }
        case 'llm_contextual':
          if (this.matchesContextualCondition(sourceCode, rule, tagSet)) {
            llmCandidates.llm_contextual.push({ rule });
            llmCandidates.total += 1;
          }
          break;

        case 'llm_with_ast':
          if (this.matchesAstCondition(sourceCode, astAnalysis, rule)) {
            llmCandidates.llm_with_ast.push({ rule, astAnalysis });
            llmCandidates.total += 1;
          }
          break;

        default:
          if (this.matchesContextualCondition(sourceCode, rule, tagSet)) {
            llmCandidates.llm_contextual.push({ rule });
            llmCandidates.total += 1;
          }
      }
    }

    return { pureRegexViolations, llmCandidates };
  }

  // ─── pure_regex ─────────────────────────────────────────────────────────────

  checkPureRegex(sourceCode, rule) {
    const violations = [];
    const lines      = sourceCode.split('\n');

    if (rule.antiPatterns && rule.antiPatterns.length > 0) {
      for (const antiPattern of rule.antiPatterns) {
        const regex = this._compilePattern(antiPattern, rule.ruleId);
        if (!regex) continue;

        regex.lastIndex = 0;
        let match;

        while ((match = regex.exec(sourceCode)) !== null) {
          const beforeMatch = sourceCode.substring(0, match.index);
          const lineNumber  = (beforeMatch.match(/\n/g) || []).length + 1;
          const lineContent = lines[lineNumber - 1] || '';

          if (this.matchesGoodPattern(lineContent, rule.goodPatterns, rule.ruleId)) continue;

          violations.push({
            ruleId:      rule.ruleId,
            title:       rule.title || '',
            line:        lineNumber,
            severity:    rule.severity || 'MEDIUM',
            description: antiPattern.description || rule.description || '',
            suggestion:  rule.suggestion || '',
            category:    rule.category || 'general',
            checkType:   'pure_regex',
            source:      'code_checker_regex'
          });
        }
      }
    }

    return { violations };
  }

  matchesGoodPattern(lineContent, goodPatterns, ruleId = '') {
    if (!goodPatterns || goodPatterns.length === 0) return false;
    for (const gp of goodPatterns) {
      const regex = this._compilePattern(gp, ruleId);
      if (!regex) continue;
      regex.lastIndex = 0;
      if (regex.test(lineContent)) return true;
    }
    return false;
  }

  findRegexCandidates(sourceCode, rule) {
    const candidates = [];
    const lines      = sourceCode.split('\n');

    if (!rule.antiPatterns || rule.antiPatterns.length === 0) return candidates;

    for (const antiPattern of rule.antiPatterns) {
      const regex = this._compilePattern(antiPattern, rule.ruleId);
      if (!regex) continue;

      regex.lastIndex = 0;
      let match;

      while ((match = regex.exec(sourceCode)) !== null) {
        const beforeMatch = sourceCode.substring(0, match.index);
        const lineNumber  = (beforeMatch.match(/\n/g) || []).length + 1;
        const lineContent = lines[lineNumber - 1] || '';

        if (this.matchesGoodPattern(lineContent, rule.goodPatterns, rule.ruleId)) continue;

        candidates.push({
          line:               lineNumber,
          content:            lineContent.trim(),
          matchedText:        match[0],
          patternDescription: antiPattern.description || ''
        });

        if (candidates.length >= 10) break;
      }
    }

    return candidates;
  }

  /**
   * 패턴 객체 {pattern, flags, description}를 RegExp로 컴파일
   * 
   * - 저장/조회 시에는 {pattern, flags, description} 문자열 그대로 유지
   * - Code Check 시점에만 이 메서드로 RegExp 생성
   * - PCRE 잔존 패턴 자동 변환 (저장 시 변환 누락 엣지 케이스 방어)
   * 
   * @param {Object} patternObj - { pattern: string, flags: string, description: string }
   * @param {string} ruleId - 로깅용 규칙 ID
   * @returns {RegExp|null} 컴파일된 정규식 또는 null (실패 시)
   * @private
   */
  _compilePattern(patternObj, ruleId = '') {
    if (!patternObj || !patternObj.pattern) return null;

    try {
      const converted = this._convertPCREtoJS(patternObj.pattern, patternObj.flags || 'g');
      return new RegExp(converted.pattern, converted.flags);
    } catch (error) {
      logger.warn(`[${ruleId}] 패턴 컴파일 실패: ${patternObj.pattern} — ${error.message}`);
      return null;
    }
  }

  /**
   * PCRE 정규식을 JavaScript RegExp로 변환
   * codeTagger._convertPCREtoJS와 동일 로직
   * @private
   */
  _convertPCREtoJS(pattern, flags) {
    let newPattern = pattern;
    const flagSet = new Set(flags.split(''));

    // 선두 인라인 플래그: (?imsx)
    const leadingMatch = newPattern.match(/^\(\?([imsx]+)\)/);
    if (leadingMatch) {
      const inlineFlags = leadingMatch[1];
      newPattern = newPattern.replace(/^\(\?[imsx]+\)/, '');
      if (inlineFlags.includes('i')) flagSet.add('i');
      if (inlineFlags.includes('m')) flagSet.add('m');
      if (inlineFlags.includes('s')) flagSet.add('s');
    }

    // 중간 인라인 플래그: (?i:...) → (?:...)
    newPattern = newPattern.replace(/\(\?([imsx]+):/g, (_, inlineFlags) => {
      if (inlineFlags.includes('i')) flagSet.add('i');
      if (inlineFlags.includes('m')) flagSet.add('m');
      if (inlineFlags.includes('s')) flagSet.add('s');
      return '(?:';
    });
    newPattern = newPattern.replace(/\(\?[imsx]+\)/g, '');

    // Atomic groups (?>...) → (?:...)
    newPattern = newPattern.replace(/\(\?>/g, '(?:');

    // Possessive quantifiers
    newPattern = newPattern.replace(/\+\+/g, '+');
    newPattern = newPattern.replace(/\*\+/g, '*');
    newPattern = newPattern.replace(/\?\+/g, '?');

    // Named groups (?P<n>...) → (?<n>...)
    newPattern = newPattern.replace(/\(\?P</g, '(?<');

    // Named backreference (?P=name) → \k<n>
    newPattern = newPattern.replace(/\(\?P=(\w+)\)/g, '\\k<$1>');

    return { pattern: newPattern, flags: Array.from(flagSet).join('') };
  }

  matchesContextualCondition(sourceCode, rule, tagSet) {
    if (rule.keywords && rule.keywords.length > 0) {
      const lowerCode  = sourceCode.toLowerCase();
      const hasKeyword = rule.keywords.some(kw => lowerCode.includes(String(kw).toLowerCase()));
      if (hasKeyword) return true;
    }
    if (rule.requiredTags && rule.requiredTags.length > 0) {
      const allPresent = rule.requiredTags.every(tag => tagSet.has(tag));
      if (allPresent) return true;
    }
    if (rule.tagCondition) {
      // [Fix #1] qdrantClient.evaluateExpression → 내부 메서드 사용
      return this._evaluateTagExpression(rule.tagCondition, tagSet);
    }
    // [Fix #2] 조건이 없는 규칙은 통과 (1차 필터인 evaluateTagCondition을 이미 통과한 규칙)
    // 기존: return false → 조건 미설정 llm_contextual 규칙이 전부 탈락됨
    return true;
  }

  /**
   * 태그 표현식 평가 (AND, OR, NOT, 괄호 지원)
   * qdrantClient.evaluateExpression()과 동일 로직을 내재화
   * 
   * @param {string} expression - 태그 표현식 (예: "USES_CONNECTION && !HAS_TRY_WITH_RESOURCES")
   * @param {Set<string>} tagSet - 태그 Set
   * @returns {boolean}
   * @private
   */
  _evaluateTagExpression(expression, tagSet) {
    if (!expression || typeof expression !== 'string') {
      return true;
    }

    try {
      let evalExpr = expression
        .replace(/&&/g, ' && ')
        .replace(/\|\|/g, ' || ')
        .replace(/!/g, ' ! ')
        .replace(/\s+/g, ' ')
        .trim();

      const tagPattern = /\b([A-Z][A-Z0-9_]*)\b/g;
      evalExpr = evalExpr.replace(tagPattern, (match) => {
        return tagSet.has(match) ? 'true' : 'false';
      });

      const result = new Function(`return (${evalExpr})`)();
      return Boolean(result);
    } catch (error) {
      logger.warn(`표현식 평가 실패: ${expression}`, error.message);
      return false;
    }
  }

  matchesAstCondition(sourceCode, astAnalysis, rule) {
    const astHints = rule.astHints || {};

    if (astHints.nodeTypes && astHints.nodeTypes.length > 0) {
      const presentNodeTypes = astAnalysis.nodeTypes || [];
      const hasRequired      = astHints.nodeTypes.some(nt => presentNodeTypes.includes(nt));
      if (!hasRequired) return false;
    }
    if (astHints.maxLineCount) {
      if (!this.hasAnyLongMethod(sourceCode, astHints.maxLineCount)) return false;
    }
    if (astHints.maxCyclomaticComplexity) {
      const complexity = astAnalysis.cyclomaticComplexity || 1;
      if (complexity <= astHints.maxCyclomaticComplexity) return false;
    }
    return true;
  }

  hasAnyLongMethod(sourceCode, maxLineCount) {
    const lines         = sourceCode.split('\n');
    const methodPattern = /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      if (methodPattern.test(lines[i])) {
        const methodInfo = this.findMethodAtLine(lines, i + 1);
        if (methodInfo.found) {
          const length = methodInfo.endLine - methodInfo.startLine + 1;
          if (length > maxLineCount) return true;
        }
      }
    }
    return false;
  }

  findMethodAtLine(lines, targetLine) {
    const methodPattern = /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;

    for (let i = Math.min(targetLine - 1, lines.length - 1); i >= 0; i--) {
      const match = lines[i].match(methodPattern);
      if (match) {
        let braceCount = 0;
        let endLine    = i;

        for (let j = i; j < lines.length; j++) {
          for (const char of lines[j]) {
            if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
          }
          if (braceCount === 0 && j > i) { endLine = j; break; }
        }
        return { found: true, name: match[1], startLine: i, endLine };
      }
    }
    return { found: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM 검증
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * LLM 개별 규칙 검증
   *
   * @param {string}   sourceCode    - 검사 대상 코드
   * @param {Object}   astAnalysis   - AST 분석 결과
   * @param {Object}   llmCandidates - 사전 필터링된 후보
   * @param {string}   fileName      - 파일명
   * @param {string[]} tags          - 태그 배열
   * @param {Function} onProgress    - 진행 콜백
   * @param {Object}   options       - 옵션 (chunkContext 포함 가능)
   */
  async verifyWithLLM(sourceCode, astAnalysis, llmCandidates, fileName, tags, onProgress = () => {}, options = {}) {
    const violations = [];

    const allItems = [
      ...llmCandidates.llm_with_regex.map(i => ({ ...i, type: 'llm_with_regex' })),
      ...llmCandidates.llm_contextual.map(i => ({ ...i, type: 'llm_contextual' })),
      ...llmCandidates.llm_with_ast.map(i => ({ ...i, type: 'llm_with_ast' }))
    ];

    if (allItems.length === 0) return violations;

    const totalItems = allItems.length;
    logger.info(`[${fileName}] LLM 개별 검증 시작: ${allItems.length}개 규칙`);

    // ✅ [Fix] 후보 라인 수집 + truncation 모드 결정
    const preserveLines = allItems
      .filter(i => i.candidates)
      .flatMap(i => i.candidates.map(c => c.line))
      .filter(Boolean);

    const isChunked = !!options.chunkContext;

    // [Fix C2] truncateCode 자체가 결과에 원본 라인 번호 prefix를 부여하도록 함.
    //   기존: truncate → addLineNumbers(_, 1) 순서 → "// ... (N줄 생략) ..." 삽입 후
    //         1부터 새로 번호가 매겨져 LLM 라인 보고와 원본 파일 라인이 어긋남.
    //   수정: truncateCode가 라인 단위로 보존된 줄에 원본 1-based 번호를 prefix로 붙임.
    //         생략 주석 자리는 prefix 없이 LLM이 무시하도록 둠.
    const numberedCode = this.truncateCode(sourceCode, 80000, preserveLines, {
      chunked: isChunked,
      preserveOriginalLineNumbers: true
    });

    // ✅ [Fix] 청킹 시 클래스명 컨텍스트
    const chunkContext = options.chunkContext || null;

    for (let i = 0; i < allItems.length; i++) {
      const item          = allItems[i];
      const rule          = item.rule;
      const ruleNum       = i + 1;
      const itemStartTime = Date.now();

      try {
        const prompt = this.buildSingleRulePrompt(numberedCode, item, astAnalysis, tags, chunkContext);

        const startTime = Date.now();
        const response  = await this.llmClient.generateCompletion(prompt, {
          temperature: 0.1,
          max_tokens:  1000
        });
        const elapsed = Date.now() - startTime;

        this._getStats().llmCalls++;
        logger.debug(`[${fileName}] 규칙 ${ruleNum}/${allItems.length} [${rule.ruleId}]: ${elapsed}ms`);

        const parsed = this.llmClient.cleanAndExtractJSON(response);

        if (parsed) {
          const violationData = parsed.violation !== undefined
            ? parsed
            : (parsed.violations?.[0] || null);

          if (violationData && violationData.violation === true) {
            violations.push({
              ruleId:      rule.ruleId,
              title:       violationData.title || rule.title || '',
              line:        violationData.line  || 0,
              severity:    rule.severity       || 'MEDIUM',
              description: violationData.description || '',
              suggestion:  violationData.suggestion  || '',
              confidence:  violationData.confidence  || 0.8,
              category:    rule.category  || 'general',
              checkType:   rule.checkType || item.type,
              source:      'code_checker_llm'
            });
            logger.info(`[${fileName}] ⚠️ 위반 발견: ${rule.ruleId} (라인 ${violationData.line || '?'})`);
          }
        }

        onProgress({
          stage:    'llm',
          current:  i + 1,
          total:    totalItems,
          ruleId:   rule.ruleId,
          checkType: item.type,
          elapsed:  Date.now() - itemStartTime
        });

        if (i < allItems.length - 1) await this._sleep(100);

      } catch (error) {
        logger.warn(`[${fileName}] 규칙 ${ruleNum} [${rule.ruleId}] LLM 실패: ${error.message}`);
        this._getStats().llmCalls++;

        onProgress({
          stage:    'llm',
          current:  i + 1,
          total:    totalItems,
          ruleId:   rule.ruleId,
          checkType: item.type,
          elapsed:  Date.now() - itemStartTime,
          error:    error.message
        });
      }
    }

    logger.info(`[${fileName}] LLM 검증 완료: ${violations.length}개 위반 발견 (${this._getStats().llmCalls}회 호출)`);
    return violations;
  }

  // ─── 프롬프트 생성 ──────────────────────────────────────────────────────────

  /**
   * 단일 규칙 검증 프롬프트
   *
   * sourceCode 는 truncateCode(...preserveOriginalLineNumbers:true) 결과로
   * 원본 1-based 라인 번호 prefix가 이미 붙어 있다.
   *
   * @param {string}      sourceCode   - 라인 번호가 붙은 코드
   * @param {Object}      item         - 검증 대상 (rule + candidates 등)
   * @param {Object}      astAnalysis  - AST 분석 결과
   * @param {string[]}    tags         - 태그 배열
   * @param {Object|null} chunkContext - 청킹 시 클래스명 정보 (null이면 비청킹)
   */
  buildSingleRulePrompt(sourceCode, item, astAnalysis, tags, chunkContext) {
    const rule = item.rule;
    const type = item.type;

    const astSection            = this._buildAstSection(astAnalysis);
    const detectedIssuesSection = this._buildDetectedIssuesSection(astAnalysis, rule);
    const profileSection        = this._buildProfileSection(tags);
    const chunkContextSection   = this._buildChunkContextSection(chunkContext);
    const examplesSection       = this._buildExamplesSection(rule);
    const contextSection        = this._buildContextSection(item, type);
    const falsePositiveGuide    = this._buildFalsePositiveGuide();

    return `다음 Java 코드가 주어진 규칙을 위반하는지 검사하세요.
${astSection}
${detectedIssuesSection}
${profileSection}
${chunkContextSection}

## 검사 대상 코드
\`\`\`java
${sourceCode}
\`\`\`
주의: line 필드에는 위 코드의 줄 번호(각 줄 앞의 숫자)를 그대로 입력하세요.

## 검사 규칙
- ID: ${rule.ruleId}
- 제목: ${rule.title}
- 설명: ${rule.description || ''}
- 심각도: ${rule.severity || 'MEDIUM'}
${examplesSection}
${contextSection}
${falsePositiveGuide}

## 응답 형식 (JSON)
\`\`\`json
{
  "violation": true 또는 false,
  "title": "위반 제목",
  "line": 위반 라인 번호 (없으면 0),
  "description": "구체적인 위반 내용",
  "suggestion": "수정 제안",
  "confidence": 0.0 ~ 1.0
}
\`\`\`

위반이 없으면 "violation": false로 응답하세요.`;
  }

  _buildAstSection(astAnalysis) {
    if (!astAnalysis) return '';
    const parts = [];
    if (astAnalysis.cyclomaticComplexity) parts.push(`- 순환 복잡도: ${astAnalysis.cyclomaticComplexity}`);
    if (astAnalysis.maxNestingDepth) parts.push(`- 최대 중첩 깊이: ${astAnalysis.maxNestingDepth}`);
    if (astAnalysis.methodCount) parts.push(`- 메서드 수: ${astAnalysis.methodCount}`);
    return parts.length > 0 ? `\n## AST 분석 정보\n${parts.join('\n')}` : '';
  }

  _buildDetectedIssuesSection(astAnalysis, rule) {
    if (!astAnalysis?.detectedIssues) return '';
    const relevant = astAnalysis.detectedIssues.filter(i => i.ruleId === rule.ruleId);
    if (relevant.length === 0) return '';
    const items = relevant.map(i => `- 라인 ${i.line}: ${i.description}`).join('\n');
    return `\n## AST가 감지한 관련 이슈\n${items}\n\n규칙 위반 판단 시 참고하세요.`;
  }

  _buildProfileSection(tags) {
    if (!tags || tags.length === 0) return '';
    const displayTags = tags.slice(0, 15).join(', ');
    const extra       = tags.length > 15 ? `, ... 외 ${tags.length - 15}개` : '';
    return `\n## 코드 프로파일\n- **태그:** ${displayTags}${extra}`;
  }

  /**
   * 청킹 시 클래스명 정보를 별도 섹션으로 제공
   */
  _buildChunkContextSection(chunkContext) {
    if (!chunkContext) return '';
    if (!chunkContext.className) return '';
    return `\n## 코드 컨텍스트\n- **클래스명:** ${chunkContext.className}`;
  }

  _buildExamplesSection(rule) {
    const parts   = [];
    const badCode = rule.problematicCode || rule.badExample;
    const goodCode = rule.fixedCode      || rule.goodExample;

    if (badCode) {
      parts.push(`\n**잘못된 예 (피해야 할 코드):**\n\`\`\`java\n${this._truncateText(badCode, 500)}\n\`\`\``);
    }
    if (goodCode) {
      parts.push(`\n**올바른 예 (권장하는 코드):**\n\`\`\`java\n${this._truncateText(goodCode, 500)}\n\`\`\``);
    }

    return parts.length === 0 ? '' : `\n## 코드 예시\n${parts.join('\n')}`;
  }

  _buildContextSection(item, type) {
    const rule = item.rule;

    if (type === 'llm_with_regex') {
      const candidateLines = item.candidates?.slice(0, 10).map(c =>
        `- 라인 ${c.line}: \`${this._truncateText(c.content, 80)}\``
      ).join('\n') || '- 없음';

      const antiPatterns = rule.antiPatterns?.slice(0, 5).map(p =>
        `- \`${p.pattern}\`${p.description ? ` - ${p.description}` : ''}`
      ).join('\n') || '- 없음';

      const goodPatterns = rule.goodPatterns?.slice(0, 5).map(p =>
        `- \`${p.pattern}\`${p.description ? ` - ${p.description}` : ''}`
      ).join('\n') || '- 없음';

      return `
## 패턴 매칭 정보
**의심되는 위치 (정규식 탐지):**
${candidateLines}

**위반 패턴 (antiPatterns):**
${antiPatterns}

**예외 패턴 (goodPatterns) - 매칭 시 위반 아님:**
${goodPatterns}`;
    }

    if (type === 'llm_with_ast') {
      const checkPoints = rule.checkPoints?.map(cp => `- ${cp}`).join('\n') || '- 규칙 준수 여부 확인';
      return `\n## AST 분석 체크포인트\n${checkPoints}\n\n위 체크포인트와 코드 구조 정보를 기반으로 검증하세요.`;
    }

    // llm_contextual
    const keywords = rule.keywords?.slice(0, 15).join(', ') || '없음';
    return `\n## 컨텍스트 분석\n- **관련 키워드:** ${keywords}\n\n코드 전체의 의미와 맥락을 분석하여 위반 여부를 판단하세요.`;
  }

  _buildFalsePositiveGuide() {
    return `
## 거짓 양성 필터링
다음 경우는 위반이 **아닙니다**:
1. 주석 내 코드 (\`//\` 또는 \`/* */\` 내부)
2. 문자열 리터럴 내 패턴 (\`"..."\` 내부)
3. 테스트 코드 (\`@Test\`, \`*Test.java\`, \`*Spec.java\`)
4. 의도적 예외 처리 (\`@SuppressWarnings\`, \`// NOSONAR\`, \`// NOPMD\`)
5. goodPatterns에 매칭되는 코드
6. import 문, package 선언문`;
  }

  // ─── 배치 폴백 (LLM 실패 시) ────────────────────────────────────────────────

  async fallbackBatchVerification(sourceCode, llmCandidates) {
    const violations = [];
    const allRules   = [
      ...llmCandidates.llm_with_regex.map(i => i.rule),
      ...llmCandidates.llm_contextual.map(i => i.rule),
      ...llmCandidates.llm_with_ast.map(i => i.rule)
    ];
    if (allRules.length === 0) return violations;

    const batchSize = 3;
    for (let i = 0; i < allRules.length; i += batchSize) {
      const batch = allRules.slice(i, i + batchSize);
      try {
        const batchViolations = await this.checkRulesBatchLLM(sourceCode, batch);
        violations.push(...batchViolations);
      } catch (error) {
        logger.warn(`배치 폴백 실패: ${error.message}`);
      }
      if (i + batchSize < allRules.length) await this._sleep(300);
    }
    return violations;
  }

  async checkRulesBatchLLM(sourceCode, rules) {
    const rulesDescription = rules.map(rule => {
      const goodExamples = rule.examples?.good || [];
      const badExamples  = rule.examples?.bad  || [];
      return `### ${rule.title} (${rule.ruleId})
${rule.description || ''}

올바른 예시:
${goodExamples.length > 0 ? goodExamples.map(ex => `- ${ex}`).join('\n') : '- (없음)'}

잘못된 예시:
${badExamples.length > 0 ? badExamples.map(ex => `- ${ex}`).join('\n') : '- (없음)'}`;
    }).join('\n---\n');

    const prompt = `다음 Java 코드가 제시된 개발 가이드라인들을 준수하는지 검사해주세요.

## 검사 대상 코드:
\`\`\`java
${this.truncateCode(sourceCode, 2000)}
\`\`\`

## 적용할 가이드라인들:
${rulesDescription}

## 검사 결과 형식 (JSON):
\`\`\`json
{
  "violations": [
    {
      "ruleId": "규칙 ID",
      "title": "규칙 제목",
      "violation": true,
      "line": 위반 라인 번호,
      "description": "구체적인 위반 내용",
      "suggestion": "수정 제안"
    }
  ]
}
\`\`\`

위반사항이 없으면 violations를 빈 배열로 반환해주세요.`;

    const response = await this.llmClient.generateCompletion(prompt, { temperature: 0.1, max_tokens: 1500 });
    return this.parseBatchResponse(response, rules);
  }

  parseBatchResponse(response, rules) {
    const violations = [];
    try {
      const parsed = this.llmClient.cleanAndExtractJSON(response);
      if (parsed && parsed.violations && Array.isArray(parsed.violations)) {
        for (const v of parsed.violations) {
          if (v.violation === true || v.violation === undefined) {
            const rule = rules.find(r => r.ruleId === v.ruleId);
            violations.push({
              ruleId:      v.ruleId   || 'UNKNOWN',
              title:       v.title    || rule?.title || '',
              line:        v.line     || 0,
              severity:    rule?.severity  || 'MEDIUM',
              description: v.description  || '',
              suggestion:  v.suggestion   || '',
              category:    rule?.category || 'general',
              checkType:   rule?.checkType || 'llm_contextual',
              source:      'code_checker_batch'
            });
          }
        }
      }
    } catch (error) {
      logger.warn(`배치 응답 파싱 실패: ${error.message}`);
    }
    return violations;
  }

  // ─── 유틸리티 ────────────────────────────────────────────────────────────────

  deduplicateViolations(violations) {
    const seen = new Map();
    return violations.filter(violation => {
      const key = `${violation.line}-${violation.ruleId}-${violation.column || 0}`;
      if (seen.has(key)) return false;
      seen.set(key, true);
      return true;
    });
  }

  /**
   * 코드 truncation (3단계)
   *
   * Step 1: maxLength 이하면 전체 투입
   * Step 2: 주석 처리된 코드 제거 (이중주석, 주석코드 등)
   * Step 3: 후보 라인에서 먼 줄부터 제거
   *         - chunked=true  (파일 검사): 메서드 시그니처 보존 + 후보 가까운 줄 보존
   *         - chunked=false (선택 검사): 후보 가까운 줄만 보존
   *
   * [Fix C2] options.preserveOriginalLineNumbers=true 시
   *   결과의 각 줄 앞에 원본 1-based 라인 번호를 prefix로 부여한다
   *   ("  42: code"). addLineNumbers를 별도 호출하면 truncated 후
   *   1부터 새로 매겨져 LLM 라인 보고가 원본과 어긋나기 때문.
   *   "// ... (N줄 생략) ..." 자리는 prefix 없이 그대로 둔다 (LLM이 무시).
   *
   * @param {string}   code          - 소스 코드
   * @param {number}   maxLength     - 최대 글자 수
   * @param {number[]} preserveLines - 반드시 보존할 라인 번호 (1-based)
   * @param {Object}   options       - { chunked, preserveOriginalLineNumbers }
   * @returns {string} 잘린 코드 (옵션 사용 시 라인 번호 prefix 포함)
   */
  truncateCode(code, maxLength, preserveLines = [], options = {}) {
    const withLineNum = options.preserveOriginalLineNumbers || false;
    const prefix = (originalLineNum) =>
      withLineNum ? `${String(originalLineNum).padStart(4, ' ')}: ` : '';

    // ─── Step 1: 전체 코드 투입 시도 ─────────────────────────────────
    if (!code) return code;
    if (code.length <= maxLength) {
      if (!withLineNum) return code;
      return code.split('\n')
        .map((line, i) => `${prefix(i + 1)}${line}`)
        .join('\n');
    }

    const lines = code.split('\n');

    // ─── Step 2: 주석 처리된 코드 제거 ───────────────────────────────
    const cleanedFlags = new Array(lines.length).fill(true);

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // 이중 주석: // //
      if (/^\/\/\s*\/\//.test(trimmed)) {
        cleanedFlags[i] = false;
        continue;
      }

      // 주석 처리된 코드: // ... ;
      if (/^\/\/\s*.*;\s*$/.test(trimmed)) {
        cleanedFlags[i] = false;
        continue;
      }

      // 주석 처리된 코드: // ... {
      if (/^\/\/\s*.*\{\s*$/.test(trimmed)) {
        cleanedFlags[i] = false;
        continue;
      }

      // 주석 처리된 코드: // ... }
      if (/^\/\/\s*.*\}\s*$/.test(trimmed)) {
        cleanedFlags[i] = false;
        continue;
      }

      // 주석 처리된 제어문: // if ..., // else ...
      if (/^\/\/\s*(if|else)\s/.test(trimmed)) {
        cleanedFlags[i] = false;
        continue;
      }
    }

    const afterCommentClean = [];
    const lineMapping = [];

    for (let i = 0; i < lines.length; i++) {
      if (cleanedFlags[i]) {
        afterCommentClean.push(lines[i]);
        lineMapping.push(i);
      }
    }

    const cleanedCode = afterCommentClean.join('\n');
    if (cleanedCode.length <= maxLength) {
      if (!withLineNum) return cleanedCode;
      return afterCommentClean
        .map((line, i) => `${prefix(lineMapping[i] + 1)}${line}`)
        .join('\n');
    }

    // ─── Step 3: 후보 라인에서 먼 줄부터 제거 ────────────────────────
    if (preserveLines.length === 0) {
      // 보존 라인 없으면 앞뒤 폴백
      // 라인 번호 prefix가 켜진 상태에서는 "앞뒤 byte 절반 자르기"가 라인 prefix를
      // 깨뜨리므로 라인 단위 폴백으로 변경한다.
      if (withLineNum) {
        const lineCount = afterCommentClean.length;
        const headLines = Math.floor(lineCount / 2);
        const tailLines = lineCount - headLines;
        const head = afterCommentClean.slice(0, headLines)
          .map((line, i) => `${prefix(lineMapping[i] + 1)}${line}`).join('\n');
        const tail = afterCommentClean.slice(-tailLines)
          .map((line, idx) => {
            const i = lineCount - tailLines + idx;
            return `${prefix(lineMapping[i] + 1)}${line}`;
          }).join('\n');
        return `${head}\n\n// ... (truncated) ...\n\n${tail}`;
      }
      const half  = Math.floor(maxLength / 2);
      const start = cleanedCode.substring(0, half);
      const end   = cleanedCode.substring(cleanedCode.length - half);
      return `${start}\n\n// ... (${cleanedCode.length - maxLength} characters truncated) ...\n\n${end}`;
    }

    const isChunked = options.chunked || false;
    const distances = new Array(afterCommentClean.length).fill(Infinity);
    const mustKeep = new Set();

    for (let i = 0; i < afterCommentClean.length; i++) {
      const originalLineNum = lineMapping[i] + 1;  // 1-based

      // 청킹 모드: 메서드 시그니처 (첫 20줄, 마지막 5줄) 보존
      if (isChunked && (i < 20 || i >= afterCommentClean.length - 5)) {
        mustKeep.add(i);
        distances[i] = 0;
        continue;
      }

      // 후보 라인 자체는 반드시 보존
      if (preserveLines.includes(originalLineNum)) {
        mustKeep.add(i);
        distances[i] = 0;
        continue;
      }

      // 가장 가까운 후보 라인까지의 거리
      let minDist = Infinity;
      for (const pLine of preserveLines) {
        const dist = Math.abs(originalLineNum - pLine);
        if (dist < minDist) minDist = dist;
      }
      distances[i] = minDist;
    }

    // 거리 먼 순으로 정렬 (제거 우선순위)
    const removable = [];
    for (let i = 0; i < afterCommentClean.length; i++) {
      if (!mustKeep.has(i)) {
        removable.push(i);
      }
    }
    removable.sort((a, b) => distances[b] - distances[a]);

    // 먼 줄부터 하나씩 제거하면서 한도 체크
    const keepFlags = new Array(afterCommentClean.length).fill(true);
    let currentLength = cleanedCode.length;

    for (const idx of removable) {
      if (currentLength <= maxLength) break;
      keepFlags[idx] = false;
      currentLength -= (afterCommentClean[idx].length + 1);  // +1 for \n
    }

    // 결과 조합 — 보존된 줄에 원본 라인 번호 prefix 부여
    const resultParts = [];
    let lastKeptIdx = -1;

    for (let i = 0; i < afterCommentClean.length; i++) {
      if (!keepFlags[i]) continue;

      if (lastKeptIdx >= 0 && i > lastKeptIdx + 1) {
        const skipped = i - lastKeptIdx - 1;
        resultParts.push(`// ... (${skipped}줄 생략) ...`);
      }
      const originalLineNum = lineMapping[i] + 1;
      resultParts.push(`${prefix(originalLineNum)}${afterCommentClean[i]}`);
      lastKeptIdx = i;
    }

    return resultParts.join('\n');
  }

  _truncateText(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
  }

  getFilteringStats()  { return { ...this.filteringStats }; }

  resetFilteringStats() {
    this.filteringStats = {
      totalChecks: 0, pureRegexViolations: 0,
      llmCandidates: 0, llmCalls: 0, falsePositivesFiltered: 0
    };
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // ─── 미사용 배치 프롬프트 (참고용 보존) ──────────────────────────────────────

  buildSectionedPrompt(sourceCode, llmCandidates) {
    const truncatedCode = this.truncateCode(sourceCode, 3000);
    let sections = [];

    if (llmCandidates.llm_with_regex.length > 0) {
      const regexSection = llmCandidates.llm_with_regex.map(item => {
        const candidateLines = item.candidates.map(c => `    - 라인 ${c.line}: ${c.content}`).join('\n');
        return `### [${item.rule.ruleId}] ${item.rule.title}\n${item.rule.description || ''}\n**의심 위치:**\n${candidateLines}`;
      }).join('\n\n');
      sections.push(`## 1. 정규식 후보 검증 (llm_with_regex)\n${regexSection}`);
    }
    if (llmCandidates.llm_contextual.length > 0) {
      const contextSection = llmCandidates.llm_contextual.map(item =>
        `### [${item.rule.ruleId}] ${item.rule.title}\n${item.rule.description || ''}\n키워드: ${(item.rule.keywords || []).join(', ')}`
      ).join('\n\n');
      sections.push(`## 2. 컨텍스트 분석 (llm_contextual)\n${contextSection}`);
    }
    if (llmCandidates.llm_with_ast.length > 0) {
      const astSection = llmCandidates.llm_with_ast.map(item => {
        const checkPoints = (item.rule.checkPoints || []).map(cp => `    - ${cp}`).join('\n');
        return `### [${item.rule.ruleId}] ${item.rule.title}\n${item.rule.astDescription || item.rule.description || ''}\n**체크포인트:**\n${checkPoints}`;
      }).join('\n\n');
      sections.push(`## 3. AST 기반 분석 (llm_with_ast)\n${astSection}`);
    }

    return `다음 Java 코드에서 제시된 규칙들의 위반 여부를 검사해주세요.\n\n## 검사 대상 코드\n\`\`\`java\n${truncatedCode}\n\`\`\`\n\n${sections.join('\n\n')}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton & Export
// ═══════════════════════════════════════════════════════════════════════════════

let instance = null;

export function getCodeChecker() {
  if (!instance) instance = new CodeChecker();
  return instance;
}

export function resetCodeChecker() {
  instance = null;
}

export async function checkCode() {
  const checker = getCodeChecker();
  await checker.initialize();
  return await checker.checkAll();
}

export default CodeChecker;