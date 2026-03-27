/**
 * 코드 태거 (JSON 정의 기반)
 * 
 * tag-definitions.json에서 패턴을 로드하여 태그 추출
 * - tier 1: 정규식 기반 빠른 태그 추출
 * - tier 2: LLM 기반 컨텍스트 태그 추출 (선택적)
 * - 복합 태그: 기본 태그 조합으로 자동 계산
 * 
 * 변경사항:
 * - [Fix C] loadPatternsFromJSON(): PCRE→JS 변환 추가
 * - [Fix #2] extractByAst(): parse() → parseJavaCode()로 통일
 * - [Fix #6] extractByRegex(): regex.lastIndex 매칭 전후 전체 리셋
 * - [Fix #9] loadPatternsFromJSON(): matchType='none' 태그는 compiledPatterns에서 제외
 * 
 * @module tagger/codeTagger
 */

import { getJavaAstParser } from '../ast/javaAstParser.js';
import { getTagDefinitionLoader } from './tagDefinitionLoader.js';
import { getLLMClient } from '../clients/llmClient.js';
import logger from '../../utils/loggerUtils.js';

export class CodeTagger {
  constructor() {
    this.astParser = null;
    this.tagLoader = null;
    this.llmClient = null;
    this.initialized = false;
    
    // JSON에서 로드한 정규식 패턴 (컴파일된 RegExp)
    this.compiledPatterns = new Map(); // tagName → { patterns: RegExp[], matchType: string }
    
    // JSON에서 로드한 메트릭 태그
    this.metricTags = new Map(); // tagName → { metric: string, threshold: number }
    
    // JSON에서 로드한 LLM 태그
    this.llmTags = new Map(); // tagName → { criteria: string, triggerTags: string[] }
  }

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    this.astParser = getJavaAstParser();
    this.tagLoader = getTagDefinitionLoader();
    await this.tagLoader.initialize();
    
    this.llmClient = getLLMClient();

    // JSON에서 패턴 로드 및 컴파일
    this.loadPatternsFromJSON();

    this.initialized = true;
    logger.info(`✅ CodeTagger 초기화 완료 (정규식: ${this.compiledPatterns.size}개, 메트릭: ${this.metricTags.size}개, LLM: ${this.llmTags.size}개)`);
  }

  /**
   * JSON에서 패턴 로드 및 컴파일
   * 
   * [Fix C] PCRE→JS 변환 추가
   *   기존: new RegExp(patternStr, config.flags || 'g')
   *     → (?m), (?i), (?s) 등 PCRE 인라인 플래그에서 SyntaxError → 조용히 스킵
   *   수정: _convertPCREtoJS()로 인라인 플래그를 JS flags로 변환 후 RegExp 생성
   */
  loadPatternsFromJSON() {
    // 1. 정규식 패턴 로드 및 컴파일
    const regexPatterns = this.tagLoader.getRegexTagPatterns();
    for (const [tagName, config] of regexPatterns) {
      // [Fix #9] matchType이 'none'이면 컴파일 자체를 건너뜀 (CONTEXT_DOCUMENT 등)
      if (config.matchType === 'none') {
        logger.debug(`정규식 스킵 [${tagName}]: matchType=none`);
        continue;
      }

      const compiledRegexes = [];
      
      for (const patternStr of config.patterns) {
        try {
          // [Fix C] PCRE→JS 변환 후 RegExp 생성
          const converted = this._convertPCREtoJS(patternStr, config.flags || 'g');
          const regex = new RegExp(converted.pattern, converted.flags);
          compiledRegexes.push(regex);
        } catch (error) {
          // 1차 변환 실패 시 추가 정제 시도
          try {
            const sanitized = this._sanitizePattern(patternStr);
            const regex = new RegExp(sanitized, config.flags || 'g');
            compiledRegexes.push(regex);
            logger.warn(`정규식 정제 후 컴파일 성공 [${tagName}]: ${patternStr} → ${sanitized}`);
          } catch (error2) {
            logger.warn(`정규식 컴파일 실패 [${tagName}]: ${patternStr} - ${error.message}`);
          }
        }
      }
      
      if (compiledRegexes.length > 0) {
        this.compiledPatterns.set(tagName, {
          patterns: compiledRegexes,
          matchType: config.matchType || 'any',
          excludeInComments: config.excludeInComments || false
        });
      }
    }

    // 2. 메트릭 태그 로드
    this.metricTags = this.tagLoader.getMetricTags();

    // 3. LLM 태그 로드
    this.llmTags = this.tagLoader.getLLMTags();

    logger.debug(`패턴 로드 완료: 정규식 ${this.compiledPatterns.size}개, 메트릭 ${this.metricTags.size}개, LLM ${this.llmTags.size}개`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [Fix C] PCRE→JS 변환 (qdrantClient._convertPCREtoJS와 동일 로직)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * PCRE 정규식을 JavaScript RegExp로 변환
   * 
   * PCRE 전용 기능을 JS 호환 형태로 변환:
   * - (?i), (?m), (?s), (?x) 등 인라인 플래그 → JS flags로 이동
   * - (?i:...) 등 그룹 내 플래그 → (?:...)로 변환
   * - (?>...) atomic group → (?:...)
   * - 소유 수량자 ++, *+, ?+ → +, *, ?
   * - (?P<n>...) → (?<n>...) 명명 그룹
   * - (?P=name) → \k<name> 역참조
   * 
   * @param {string} pattern - PCRE 패턴 문자열
   * @param {string} flags - 기본 플래그
   * @returns {{ pattern: string, flags: string }}
   * @private
   */
  _convertPCREtoJS(pattern, flags) {
    let newPattern = pattern;
    let newFlags = flags;
    
    // Set으로 관리하여 중복 플래그 방지
    const flagSet = new Set(newFlags.split(''));
    
    // 1. 선두 인라인 플래그 추출 및 제거: (?imsx)
    const leadingMatch = newPattern.match(/^\(\?([imsx]+)\)/);
    if (leadingMatch) {
      const inlineFlags = leadingMatch[1];
      newPattern = newPattern.replace(/^\(\?[imsx]+\)/, '');
      
      if (inlineFlags.includes('i')) flagSet.add('i');
      if (inlineFlags.includes('m')) flagSet.add('m');
      if (inlineFlags.includes('s')) flagSet.add('s');
    }
    
    // 2. 패턴 중간의 인라인 플래그도 처리
    // (?i:...) → (?:...) + 'i' 플래그
    newPattern = newPattern.replace(/\(\?([imsx]+):/g, (match, inlineFlags) => {
      if (inlineFlags.includes('i')) flagSet.add('i');
      if (inlineFlags.includes('m')) flagSet.add('m');
      if (inlineFlags.includes('s')) flagSet.add('s');
      return '(?:';
    });
    // (?i) 중간 독립 플래그 제거
    newPattern = newPattern.replace(/\(\?[imsx]+\)/g, '');
    
    // 3. Atomic groups (?>...) → (?:...)
    newPattern = newPattern.replace(/\(\?>/g, '(?:');
    
    // 4. Possessive quantifiers ++, *+, ?+ → +, *, ?
    newPattern = newPattern.replace(/\+\+/g, '+');
    newPattern = newPattern.replace(/\*\+/g, '*');
    newPattern = newPattern.replace(/\?\+/g, '?');
    
    // 5. Named groups (?P<n>...) → (?<n>...)
    newPattern = newPattern.replace(/\(\?P</g, '(?<');
    
    // 6. Named backreference (?P=name) → \k<name>
    newPattern = newPattern.replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
    
    newFlags = Array.from(flagSet).join('');
    
    return { pattern: newPattern, flags: newFlags };
  }

  /**
   * 패턴 추가 정제 (변환 후에도 실패할 경우)
   * @private
   */
  _sanitizePattern(pattern) {
    if (typeof pattern !== 'string') return '';
    
    let sanitized = pattern;
    
    // PCRE inline flags 제거
    sanitized = sanitized.replace(/^\(\?[imsx]+\)/, '');
    sanitized = sanitized.replace(/\(\?[imsx]+:/g, '(?:');
    sanitized = sanitized.replace(/\(\?[imsx]+\)/g, '');
    
    // 짝이 맞지 않는 괄호 정리
    let parenCount = 0;
    let inBracket = false;
    
    for (let i = 0; i < sanitized.length; i++) {
      const char = sanitized[i];
      const prevChar = i > 0 ? sanitized[i - 1] : '';
      
      if (prevChar !== '\\') {
        if (char === '[' && !inBracket) inBracket = true;
        else if (char === ']' && inBracket) inBracket = false;
        else if (char === '(' && !inBracket) parenCount++;
        else if (char === ')' && !inBracket) parenCount--;
      }
    }
    
    if (parenCount > 0) sanitized += ')'.repeat(parenCount);
    if (inBracket) sanitized += ']';
    
    return sanitized;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 메인: 태그 추출
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 코드에서 태그 추출 (메인 메서드)
   * 
   * @param {string} code - Java 소스 코드
   * @param {Object} options - 옵션
   * @param {boolean} [options.useLLM=false] - LLM 태깅 사용 여부
   * @returns {Promise<Object>} 태깅 결과
   */
  async extractTags(code, options = {}) {
    if (!code) {
      return { tags: [], details: {}, error: 'No code provided' };
    }

    const startTime = Date.now();
    
    // 주석과 문자열 제거
    const cleanedCode = this.removeCommentsAndStrings(code);
    const details = {};

    // 1. 정규식 기반 태그 추출 (JSON 패턴 사용)
    const regexTags = this.extractByRegex(cleanedCode, code);
    Object.assign(details, { regex: regexTags });

    // 2. AST 기반 태그 추출
    const astTags = this.extractByAst(code);
    Object.assign(details, { ast: astTags });

    // 3. 메트릭 기반 태그 (JSON threshold 사용)
    const metricTags = this.extractByMetrics(code, astTags.analysis);
    Object.assign(details, { metrics: metricTags });

    // 4. AST 컨텍스트 기반 태그
    const contextTags = this.extractByAstContext(code, astTags.analysis);
    Object.assign(details, { context: contextTags });

    // 5. 복합 태그 평가
    const allBaseTags = new Set([
      ...regexTags.tags,
      ...astTags.tags,
      ...metricTags.tags,
      ...contextTags.tags
    ]);
    const compoundTags = this.evaluateCompoundTags(allBaseTags);
    Object.assign(details, { compound: compoundTags });

    // 6. LLM 기반 태그 (옵션, tier 2 태그)
    let llmTags = { tags: [] };
    if (options.useLLM) {
      llmTags = await this.extractByLLM(code, allBaseTags);
      Object.assign(details, { llm: llmTags });
    }

    // 전체 태그 통합
    const allTags = new Set([
      ...regexTags.tags,
      ...astTags.tags,
      ...metricTags.tags,
      ...contextTags.tags,
      ...compoundTags.tags,
      ...llmTags.tags
    ]);

    const elapsed = Date.now() - startTime;
    logger.debug(`태그 추출 완료: ${allTags.size}개 (${elapsed}ms)`);

    return {
      tags: Array.from(allTags),
      details,
      stats: {
        totalTags: allTags.size,
        extractionTimeMs: elapsed,
        bySource: {
          regex: regexTags.tags.length,
          ast: astTags.tags.length,
          metrics: metricTags.tags.length,
          context: contextTags.tags.length,
          compound: compoundTags.tags.length,
          llm: llmTags.tags.length
        }
      },
      error: null
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 정규식 기반 추출 (JSON 패턴 사용)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 정규식 기반 태그 추출 (JSON에서 로드한 패턴 사용)
   * 
   * @param {string} cleanedCode - 주석/문자열 제거된 코드
   * @param {string} originalCode - 원본 코드
   * @returns {Object} { tags: string[], matches: Object }
   */
  extractByRegex(cleanedCode, originalCode) {
    const tags = [];
    const matches = {};

    for (const [tagName, config] of this.compiledPatterns) {
      const codeToCheck = config.excludeInComments ? cleanedCode : originalCode;
      
      let matched = false;

      // [Fix #6] 매칭 전 모든 regex의 lastIndex를 일괄 리셋
      // 기존: some()/every() 내부에서 개별 리셋 → 중단 시 나머지 regex의 lastIndex 잔류
      // 수정: 전체 리셋 후 매칭 → 다음 호출에서도 안전
      config.patterns.forEach(r => { r.lastIndex = 0; });
      
      if (config.matchType === 'all') {
        // 모든 패턴이 매칭되어야 함
        matched = config.patterns.every(regex => regex.test(codeToCheck));
      } else if (config.matchType === 'none') {
        // matchType이 'none'이면 매칭하지 않음 (CONTEXT_DOCUMENT 등)
        matched = false;
      } else {
        // 하나라도 매칭되면 됨 (default: 'any')
        matched = config.patterns.some(regex => regex.test(codeToCheck));
      }

      // 매칭 후에도 리셋 (test가 lastIndex를 전진시키므로)
      config.patterns.forEach(r => { r.lastIndex = 0; });
      
      if (matched) {
        tags.push(tagName);
        matches[tagName] = true;
      }
    }

    // 추가 컨텍스트 기반 검사 (루프 내 DB 호출 등)
    if (this.detectDbCallInLoop(cleanedCode) && !matches['HAS_DB_CALL_IN_LOOP']) {
      tags.push('HAS_DB_CALL_IN_LOOP');
      matches['HAS_DB_CALL_IN_LOOP'] = true;
    }

    if (this.detectNestedLoop(cleanedCode) && !matches['HAS_NESTED_LOOP']) {
      tags.push('HAS_NESTED_LOOP');
      matches['HAS_NESTED_LOOP'] = true;
    }

    return { tags: [...new Set(tags)], matches };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 메트릭 기반 추출 (JSON threshold 사용)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 메트릭 기반 태그 추출 (JSON에서 로드한 threshold 사용)
   * 
   * @param {string} code - 소스 코드
   * @param {Object} analysis - AST 분석 결과
   * @returns {Object} { tags: string[], metrics: Object }
   */
  extractByMetrics(code, analysis) {
    const tags = [];
    const metrics = {};

    // 모든 사용 가능한 메트릭을 한 번에 계산
    const lineCount = code.split('\n').length;
    const methodCount = analysis?.methodCount || this.countMethods(code);
    const complexity = analysis?.cyclomaticComplexity || this.estimateComplexity(code);
    const nestingDepth = analysis?.maxNestingDepth || this.estimateNesting(code);

    const metricsMap = {
      lineCount,
      methodCount,
      complexity,
      nestingDepth
    };

    metrics.lineCount = lineCount;
    metrics.methodCount = methodCount;
    metrics.complexity = complexity;
    metrics.nestingDepth = nestingDepth;

    // JSON에서 로드한 threshold와 비교 — switch 없이 동적 조회
    for (const [tagName, config] of this.metricTags) {
      const value = metricsMap[config.metric];
      
      if (value === undefined) {
        logger.warn(`알 수 없는 메트릭: ${config.metric} (태그: ${tagName})`);
        continue;
      }
      
      if (value >= config.threshold) {
        tags.push(tagName);
        metrics[tagName] = { value, threshold: config.threshold };
      }
    }

    return { tags, metrics };
  }

  /**
   * 메서드 수 카운트
   */
  countMethods(code) {
    const methodPattern = /(?:public|private|protected)\s+[\w<>\[\],\s]+\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g;
    const matches = code.match(methodPattern);
    return matches ? matches.length : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AST 기반 추출
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * AST 기반 태그 추출
   */
  extractByAst(code) {
    // [Fix #2] parse() → parseJavaCode()로 통일 (codeChecker와 동일 메서드 사용)
    const result = this.astParser.parseJavaCode(code);
    const tags = [];
    const analysis = result.analysis;

    if (!result.success) {
      return { tags, analysis: {}, error: result.error };
    }

    // 리소스 사용
    for (const resource of analysis.resourceUsage || []) {
      const tagName = `USES_${resource.toUpperCase()}`;
      if (this.tagLoader.hasTag(tagName)) {
        tags.push(tagName);
      }
    }

    // 예외 처리
    if (analysis.exceptionHandling) {
      if (analysis.exceptionHandling.tryCatchCount > 0) {
        tags.push('HAS_TRY_CATCH');
      }
      if (analysis.exceptionHandling.hasEmptyCatch) {
        tags.push('HAS_EMPTY_CATCH');
      }
      if (analysis.exceptionHandling.hasGenericCatch) {
        tags.push('HAS_GENERIC_CATCH');
      }
      if (analysis.exceptionHandling.hasTryWithResources) {
        tags.push('HAS_TRY_WITH_RESOURCES');
      }
      if (analysis.exceptionHandling.hasCloseInFinally) {
        tags.push('HAS_CLOSE_IN_FINALLY');
      }
    }

    // 보안 패턴
    for (const pattern of analysis.securityPatterns || []) {
      if (pattern === 'SQL_CONCATENATION') {
        tags.push('HAS_SQL_CONCATENATION');
      }
      if (pattern === 'HARDCODED_PASSWORD') {
        tags.push('HAS_HARDCODED_PASSWORD');
      }
    }

    // 루프 정보
    if (analysis.loopInfo?.hasDbCallInLoop) {
      tags.push('HAS_DB_CALL_IN_LOOP');
    }

    return { tags: [...new Set(tags)], analysis };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 복합 태그 평가
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 복합 태그 평가
   */
  evaluateCompoundTags(baseTags) {
    const tags = [];
    const tagSet = baseTags instanceof Set ? baseTags : new Set(baseTags);

    for (const compoundName of this.tagLoader.getAllCompoundTagNames()) {
      const compound = this.tagLoader.getCompoundTag(compoundName);
      if (compound && this.evaluateExpression(compound.expression, tagSet)) {
        tags.push(compoundName);
      }
    }

    return { tags };
  }

  /**
   * 태그 표현식 평가
   */
  evaluateExpression(expression, tagSet) {
    if (!expression) return false;

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

      return new Function(`return (${evalExpr})`)();
    } catch (error) {
      logger.warn('표현식 평가 실패:', expression, error.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM 기반 추출 (Tier 2 태그)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * LLM 기반 태그 추출 (선택적)
   * JSON에서 정의한 tier 2 태그들을 트리거 조건에 따라 추출
   */
  async extractByLLM(code, existingTags) {
    try {
      await this.llmClient.initialize();

      // 트리거 조건에 맞는 LLM 태그만 추출
      const candidateTags = [];
      const existingTagSet = existingTags instanceof Set ? existingTags : new Set(existingTags);
      
      for (const [tagName, config] of this.llmTags) {
        // 트리거 태그가 있는지 확인
        const hasTrigger = config.triggerTags.length === 0 || 
          config.triggerTags.some(t => existingTagSet.has(t));
        
        if (hasTrigger && !existingTagSet.has(tagName)) {
          candidateTags.push({ name: tagName, criteria: config.criteria });
        }
      }

      if (candidateTags.length === 0) {
        return { tags: [] };
      }

      const tagDescriptions = candidateTags
        .map(t => `- ${t.name}: ${t.criteria}`)
        .join('\n');

      const prompt = `다음 Java 코드를 분석하고 적용 가능한 태그를 찾아주세요.

## 코드
\`\`\`java
${code.substring(0, 3000)}
\`\`\`

## 이미 추출된 태그
${Array.from(existingTagSet).join(', ')}

## 평가할 태그와 기준
${tagDescriptions}

## 출력 형식 (JSON)
{
  "matchedTags": ["해당되는 태그들만"],
  "reasoning": "각 태그 선택 이유"
}

조건에 맞는 태그만 JSON으로 출력하세요.`;

      const response = await this.llmClient.generateCompletion(prompt, {
        temperature: 0.1,
        max_tokens: 500
      });

      const result = this.llmClient.cleanAndExtractJSON(response);
      
      if (result?.matchedTags) {
        // 유효한 태그만 필터링
        const validTags = result.matchedTags.filter(tag => 
          this.tagLoader.hasTag(tag) && !existingTagSet.has(tag)
        );
        return { tags: validTags };
      }

      return { tags: [] };
    } catch (error) {
      logger.warn('LLM 태깅 실패:', error.message);
      return { tags: [], error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 컨텍스트 기반 검사
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 루프 내 DB 호출 감지
   */
  detectDbCallInLoop(code) {
    const loopPattern = /(?:for|while)\s*\([^)]*\)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gs;
    let match;

    while ((match = loopPattern.exec(code)) !== null) {
      const loopBody = match[1];
      if (/\.execute(?:Query|Update)?\s*\(|\.prepareStatement\s*\(/.test(loopBody)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 중첩 루프 감지
   */
  detectNestedLoop(code) {
    const outerLoopPattern = /(?:for|while)\s*\([^)]*\)\s*\{/g;
    let match;

    while ((match = outerLoopPattern.exec(code)) !== null) {
      const startIndex = match.index + match[0].length;
      const block = this.extractBlock(code, startIndex);
      
      if (/(?:for|while)\s*\([^)]*\)\s*\{/.test(block)) {
        return true;
      }
    }

    return false;
  }

  /**
   * AST 컨텍스트 기반 태그 추출
   */
  extractByAstContext(code, astAnalysis) {
    const tags = [];
    const details = {};

    // finally 블록 내 close() 호출 체크
    const finallyBlocks = this.extractFinallyBlocks(code);
    for (const block of finallyBlocks) {
      if (/\.close\s*\(\s*\)/.test(block)) {
        tags.push('HAS_CLOSE_IN_FINALLY');
        details['HAS_CLOSE_IN_FINALLY'] = {
          context: 'finally',
          evidence: block.substring(0, 100)
        };
        break;
      }
    }

    // 루프 내 DB 호출 체크
    const loopBlocks = this.extractLoopBlocks(code);
    for (const block of loopBlocks) {
      if (/\.execute(?:Query|Update)?\s*\(|\.prepareStatement\s*\(/.test(block)) {
        tags.push('HAS_DB_CALL_IN_LOOP');
        details['HAS_DB_CALL_IN_LOOP'] = {
          context: 'loop',
          evidence: block.substring(0, 100)
        };
        break;
      }

      // 루프 내 객체 생성
      if (/\bnew\s+\w+\s*\(/.test(block)) {
        tags.push('HAS_OBJECT_CREATION_IN_LOOP');
        details['HAS_OBJECT_CREATION_IN_LOOP'] = {
          context: 'loop',
          evidence: block.substring(0, 100)
        };
      }
    }

    // 중첩 루프 체크
    for (const block of loopBlocks) {
      if (/(?:for|while)\s*\([^)]*\)\s*\{/.test(block)) {
        tags.push('HAS_NESTED_LOOP');
        details['HAS_NESTED_LOOP'] = {
          context: 'loop',
          evidence: block.substring(0, 100)
        };
        break;
      }
    }

    return { tags: [...new Set(tags)], details };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 유틸리티 메서드
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 주석과 문자열 리터럴 제거
   */
  removeCommentsAndStrings(code) {
    if (!code) return '';
    
    // 1. 블록 주석 제거
    let cleaned = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
    
    // 2. 라인 주석 제거
    cleaned = cleaned.replace(/\/\/.*$/gm, ' ');
    
    // 3. 문자열 리터럴 제거 (이스케이프 처리 포함)
    cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    
    return cleaned;
  }

  /**
   * 중괄호 블록 추출
   */
  extractBlock(code, startIndex) {
    let braceCount = 1;
    let endIndex = startIndex;

    while (endIndex < code.length && braceCount > 0) {
      if (code[endIndex] === '{') braceCount++;
      else if (code[endIndex] === '}') braceCount--;
      endIndex++;
    }

    return code.substring(startIndex, endIndex - 1);
  }

  /**
   * finally 블록 추출
   */
  extractFinallyBlocks(code) {
    const blocks = [];
    const regex = /\}\s*finally\s*\{/g;
    let match;

    while ((match = regex.exec(code)) !== null) {
      const start = match.index + match[0].length;
      const block = this.extractBlock(code, start);
      if (block) {
        blocks.push(block);
      }
    }

    return blocks;
  }

  /**
   * 루프 블록 추출
   */
  extractLoopBlocks(code) {
    const blocks = [];
    
    const patterns = [
      /\bfor\s*\([^)]*\)\s*\{/g,
      /\bwhile\s*\([^)]*\)\s*\{/g,
      /\bdo\s*\{/g
    ];

    for (const pattern of patterns) {
      let match;
      pattern.lastIndex = 0;
      
      while ((match = pattern.exec(code)) !== null) {
        const start = match.index + match[0].length;
        const block = this.extractBlock(code, start);
        if (block) {
          blocks.push(block);
        }
      }
    }

    return blocks;
  }

  /**
   * 순환 복잡도 추정
   */
  estimateComplexity(code) {
    let complexity = 1;
    
    const patterns = [
      /\bif\s*\(/g,
      /\belse\s+if\s*\(/g,
      /\bfor\s*\(/g,
      /\bwhile\s*\(/g,
      /\bcase\s+/g,
      /\bcatch\s*\(/g,
      /\?\s*[^:]+\s*:/g,  // 삼항 연산자
      /&&/g,
      /\|\|/g
    ];

    for (const pattern of patterns) {
      const matches = code.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return complexity;
  }

  /**
   * 최대 중첩 깊이 추정
   */
  estimateNesting(code) {
    let maxDepth = 0;
    let currentDepth = 0;

    for (let i = 0; i < code.length; i++) {
      if (code[i] === '{') {
        const prev = code.substring(Math.max(0, i - 30), i);
        if (/\b(if|for|while|do|switch|try|catch|finally)\s*[\(]?[^{]*$/.test(prev)) {
          currentDepth++;
          maxDepth = Math.max(maxDepth, currentDepth);
        }
      } else if (code[i] === '}') {
        if (currentDepth > 0) currentDepth--;
      }
    }

    return maxDepth;
  }
}

/**
 * 싱글톤 인스턴스
 */
let instance = null;

export function getCodeTagger() {
  if (!instance) {
    instance = new CodeTagger();
  }
  return instance;
}

/**
 * 싱글톤 리셋 (테스트용 / Push 후 리로드용)
 */
export function resetCodeTagger() {
  instance = null;
}

export default CodeTagger;