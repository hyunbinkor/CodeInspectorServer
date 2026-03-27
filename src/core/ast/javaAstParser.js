/**
 * Java AST 파서
 * 
 * 기존 프로젝트의 검증된 로직을 기반으로 작성
 * - java-parser 대신 정규식 기반 분석 (fallback 방식)
 * - AST 시그니처 생성 (structural, semantic, behavioral)
 * - 리소스 누수, 보안 취약점, 성능 이슈 탐지
 * 
 * 변경사항:
 * - [Fix #3] fallbackAnalysis()에 codeTagger가 기대하는 필드 추가
 *   resourceUsage, exceptionHandling(객체), loopInfo, methodCount
 *   기존 필드(resourceLifecycles, exceptionHandling 배열 등)는 하위 호환을 위해 유지
 * - [Fix #3] createEmptyAnalysis()의 구조도 동일하게 정합
 * 
 * @module ast/javaAstParser
 */

import logger from '../../utils/loggerUtils.js';

export class JavaASTParser {
  constructor() {
    // 레거시 프레임워크에서 자주 사용되는 기본 클래스들 (기존 로직)
    this.frameworkClasses = [
      'BaseService', 'DataAccessLayer', 'ConnectionManager',
      'BusinessProcessor', 'AbstractController', 'ServiceImpl'
    ];

    // 명시적으로 close()를 호출해야 하는 리소스 타입들 (기존 로직)
    this.resourceTypes = [
      'Connection', 'PreparedStatement', 'ResultSet', 'Statement',
      'FileInputStream', 'FileOutputStream', 'BufferedReader', 'BufferedWriter',
      'Socket', 'ServerSocket', 'HttpURLConnection', 'InputStream', 'OutputStream'
    ];

    // 보안 취약점이 발생할 수 있는 메서드들 (기존 로직)
    this.securitySensitiveApis = [
      'executeQuery', 'executeUpdate', 'execute',
      'getWriter', 'sendRedirect', 'setAttribute',
      'encrypt', 'decrypt', 'hash', 'getParameter'
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 메인 API (기존 호환)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Java 코드 분석 (기존 API - parseJavaCode)
   * 
   * @param {string} javaCode - Java 소스 코드
   * @returns {Object} 분석 결과 { success, ast, analysis, error }
   */
  parseJavaCode(javaCode) {
    try {
      if (!javaCode || typeof javaCode !== 'string') {
        return {
          success: false,
          ast: null,
          analysis: this.createEmptyAnalysis(),
          error: 'No code provided'
        };
      }

      // java-parser 라이브러리가 완전하지 않아 정규식 기반 분석 사용 (기존 주석)
      const fallbackAnalysis = this.fallbackAnalysis(javaCode);

      return {
        success: true,
        ast: null,
        analysis: fallbackAnalysis,
        error: null
      };
    } catch (error) {
      logger.warn('Java 코드 분석 실패:', error.message);

      return {
        success: false,
        ast: null,
        analysis: this.createEmptyAnalysis(),
        error: error.message
      };
    }
  }

  /**
   * 새 API (parse) - parseJavaCode 래핑
   */
  parse(code) {
    return this.parseJavaCode(code);
  }

  /**
   * 빈 분석 결과 생성
   * 
   * [Fix #3] codeTagger가 기대하는 구조와 일치하도록 수정
   *   - exceptionHandling: 배열 → 객체 (tryCatchCount, hasEmptyCatch 등)
   *   - resourceUsage, loopInfo, methodCount 추가
   */
  createEmptyAnalysis() {
    return {
      nodeTypes: [],
      nodeCount: 0,
      maxDepth: 1,
      cyclomaticComplexity: 1,
      methodCount: 0,
      
      classDeclarations: [],
      methodDeclarations: [],
      variableDeclarations: [],
      methodInvocations: [],
      constructorCalls: [],
      controlStructures: [],
      annotations: [],
      inheritancePatterns: [],
      
      // [Fix #3] codeTagger 호환 필드
      resourceUsage: [],
      exceptionHandling: {
        tryCatchCount: 0,
        hasEmptyCatch: false,
        hasGenericCatch: false,
        hasTryWithResources: false,
        hasCloseInFinally: false
      },
      securityPatterns: [],
      loopInfo: {
        forCount: 0,
        whileCount: 0,
        doWhileCount: 0,
        hasDbCallInLoop: false,
        hasNestedLoop: false
      },

      // 기존 상세 분석 필드 (하위 호환)
      exceptionHandlingIssues: [],
      resourceLifecycles: [],
      resourceLeakRisks: [],
      securityIssues: [],
      sqlInjectionRisks: [],
      performanceIssues: [],
      loopAnalysis: {
        forCount: 0, whileCount: 0, doWhileCount: 0,
        hasDbCallInLoop: false, hasNestedLoop: false
      },
      codeSmells: [],
      designPatterns: []
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 정규식 기반 분석 (기존 fallbackAnalysis 로직)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 정규식 기반 폴백 분석
   * 
   * [Fix #3] codeTagger 호환 필드 추가
   *   기존 상세 분석 결과에서 codeTagger가 기대하는 간소화 필드를 파생
   */
  fallbackAnalysis(javaCode) {
    // 기존 분석 실행
    const resourceLifecycles = this.analyzeResourcesRegex(javaCode);
    const exceptionHandlingIssues = this.analyzeExceptionHandlingRegex(javaCode);
    const securityIssues = this.analyzeSecurityRegex(javaCode);
    const loopAnalysis = this.analyzeLoopsRegex(javaCode);
    const methodDeclarations = this.extractMethodsRegex(javaCode);

    // [Fix #3] codeTagger 호환 필드 파생
    const resourceUsage = [...new Set(resourceLifecycles.map(r => r.type))];

    const tryCatchCount = (javaCode.match(/\bcatch\s*\(/g) || []).length;
    const hasTryWithResources = /try\s*\([^)]+\)\s*\{/.test(javaCode);
    const hasCloseInFinally = /finally\s*\{[^}]*\.close\s*\(/.test(javaCode);

    const exceptionHandling = {
      tryCatchCount,
      hasEmptyCatch: exceptionHandlingIssues.some(i => i.type === 'EMPTY_CATCH'),
      hasGenericCatch: exceptionHandlingIssues.some(i => i.type === 'GENERIC_CATCH'),
      hasTryWithResources,
      hasCloseInFinally
    };

    const securityPatterns = securityIssues.map(i => i.type);

    return {
      // 기본 구조 분석
      nodeTypes: this.extractNodeTypesRegex(javaCode),
      nodeCount: this.countNodesRegex(javaCode),
      maxDepth: this.estimateDepthRegex(javaCode),
      cyclomaticComplexity: this.calculateComplexityRegex(javaCode),
      methodCount: methodDeclarations.length,

      // 선언 추출
      classDeclarations: this.extractClassesRegex(javaCode),
      methodDeclarations,
      variableDeclarations: this.extractVariablesRegex(javaCode),
      methodInvocations: this.extractMethodCallsRegex(javaCode),
      annotations: this.extractAnnotationsRegex(javaCode),

      controlStructures: [],
      inheritancePatterns: [],

      // [Fix #3] codeTagger 호환 필드 (간소화)
      resourceUsage,
      exceptionHandling,
      securityPatterns,
      loopInfo: loopAnalysis,

      // 기존 상세 분석 필드 (하위 호환 — 시그니처 생성 등에서 사용)
      exceptionHandlingIssues,
      resourceLifecycles,
      resourceLeakRisks: [],
      securityIssues,
      sqlInjectionRisks: [],
      performanceIssues: this.analyzePerformanceRegex(javaCode),
      loopAnalysis,
      codeSmells: [],
      designPatterns: []
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 노드 타입 추출 (기존 로직)
  // ═══════════════════════════════════════════════════════════════════════════════

  extractNodeTypesRegex(code) {
    const patterns = {
      'ClassDeclaration': /class\s+\w+/g,
      'InterfaceDeclaration': /interface\s+\w+/g,
      'MethodDeclaration': /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+\w+\s*\([^)]*\)\s*(?:\{|throws)/g,
      'VariableDeclaration': /(?:private|public|protected)?\s*\w+\s+\w+\s*=/g,
      'IfStatement': /if\s*\(/g,
      'ForStatement': /for\s*\(/g,
      'WhileStatement': /while\s*\(/g,
      'TryStatement': /try\s*[\{\(]/g,
      'CatchClause': /catch\s*\(/g,
      'ThrowStatement': /throw\s+/g
    };

    const nodeTypes = [];
    for (const [type, pattern] of Object.entries(patterns)) {
      const matches = code.match(pattern) || [];
      for (let i = 0; i < matches.length; i++) {
        nodeTypes.push(type);
      }
    }

    return nodeTypes;
  }

  countNodesRegex(code) {
    return this.extractNodeTypesRegex(code).length;
  }

  estimateDepthRegex(code) {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of code) {
      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return maxDepth;
  }

  calculateComplexityRegex(code) {
    const complexityPatterns = /if|for|while|switch|case|catch|\?\s*:/g;
    const matches = code.match(complexityPatterns) || [];
    return matches.length + 1;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 선언 추출 (기존 로직)
  // ═══════════════════════════════════════════════════════════════════════════════

  extractClassesRegex(code) {
    const classPattern = /(?:public\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
    const classes = [];
    let match;

    while ((match = classPattern.exec(code)) !== null) {
      classes.push({
        name: match[1],
        extends: match[2] || null,
        implements: match[3] ? match[3].split(',').map(i => i.trim()) : []
      });
    }

    return classes;
  }

  extractMethodsRegex(code) {
    const methodPattern = /(?:public|private|protected)?\s*(?:static)?\s*(\w+)\s+(\w+)\s*\(([^)]*)\)/g;
    const methods = [];
    let match;

    while ((match = methodPattern.exec(code)) !== null) {
      const excludeKeywords = ['class', 'interface', 'if', 'for', 'while', 'switch', 'catch', 'new'];
      if (!excludeKeywords.includes(match[2])) {
        methods.push({
          returnType: match[1],
          name: match[2],
          parameters: match[3].trim()
        });
      }
    }

    return methods;
  }

  extractVariablesRegex(code) {
    const varPattern = /(?:private|public|protected|final)?\s*(\w+)\s+(\w+)\s*(?:=([^;]+))?;/g;
    const variables = [];
    let match;

    const excludeTypes = ['class', 'interface', 'return', 'throw', 'new', 'if', 'for', 'while'];

    while ((match = varPattern.exec(code)) !== null) {
      if (!excludeTypes.includes(match[1])) {
        variables.push({
          type: match[1],
          name: match[2],
          hasInitializer: !!match[3]
        });
      }
    }

    return variables;
  }

  extractMethodCallsRegex(code) {
    const callPattern = /(\w+)\.(\w+)\s*\(/g;
    const calls = [];
    let match;

    while ((match = callPattern.exec(code)) !== null) {
      calls.push({
        target: match[1],
        method: match[2]
      });
    }

    return calls;
  }

  extractAnnotationsRegex(code) {
    const annotationPattern = /@(\w+)(?:\([^)]*\))?/g;
    const annotations = [];
    let match;

    while ((match = annotationPattern.exec(code)) !== null) {
      annotations.push({
        name: match[1]
      });
    }

    return annotations;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 리소스/보안/성능 분석 (기존 로직)
  // ═══════════════════════════════════════════════════════════════════════════════

  analyzeResourcesRegex(code) {
    const resources = [];

    for (const resourceType of this.resourceTypes) {
      const pattern = new RegExp(`${resourceType}\\s+(\\w+)\\s*=`, 'g');
      let match;

      while ((match = pattern.exec(code)) !== null) {
        const varName = match[1];

        const tryWithResourcesPattern = new RegExp(`try\\s*\\([^)]*${varName}[^)]*\\)`, 'g');
        const inTryWithResources = tryWithResourcesPattern.test(code);

        const closePattern = new RegExp(`${varName}\\.close\\(\\)`, 'g');
        const hasCloseCall = closePattern.test(code);

        resources.push({
          type: resourceType,
          variable: varName,
          inTryWithResources,
          hasCloseCall,
          riskLevel: (!inTryWithResources && !hasCloseCall) ? 'HIGH' : 'LOW'
        });
      }
    }

    return resources;
  }

  analyzeSecurityRegex(code) {
    const securityIssues = [];

    if (code.includes('executeQuery') || code.includes('executeUpdate')) {
      const sqlConcatPattern = /["'].*\+.*["']/g;
      if (sqlConcatPattern.test(code)) {
        securityIssues.push({
          type: 'SQL_CONCATENATION',
          description: 'String concatenation in SQL query',
          severity: 'HIGH'
        });
      }
    }

    if (code.includes('getWriter') && code.includes('println')) {
      securityIssues.push({
        type: 'XSS',
        description: 'Direct output without encoding',
        severity: 'MEDIUM'
      });
    }

    if (/(?:password|passwd|pwd)\s*=\s*["'][^"']+["']/i.test(code)) {
      securityIssues.push({
        type: 'HARDCODED_PASSWORD',
        description: 'Hardcoded password detected',
        severity: 'HIGH'
      });
    }

    return securityIssues;
  }

  analyzePerformanceRegex(code) {
    const performanceIssues = [];

    const loopWithQueryPattern = /(for|while)\s*\([^)]*\)\s*\{[^}]*(?:executeQuery|find|get)[^}]*\}/g;
    if (loopWithQueryPattern.test(code)) {
      performanceIssues.push({
        type: 'N_PLUS_ONE_QUERY',
        description: 'Database query inside loop',
        severity: 'HIGH'
      });
    }

    const loopWithNewPattern = /(for|while)\s*\([^)]*\)\s*\{[^}]*new\s+\w+[^}]*\}/g;
    if (loopWithNewPattern.test(code)) {
      performanceIssues.push({
        type: 'OBJECT_CREATION_IN_LOOP',
        description: 'Object creation inside loop',
        severity: 'MEDIUM'
      });
    }

    return performanceIssues;
  }

  analyzeExceptionHandlingRegex(code) {
    const issues = [];

    if (/catch\s*\([^)]+\)\s*\{\s*\}/s.test(code)) {
      issues.push({
        type: 'EMPTY_CATCH',
        description: 'Empty catch block',
        severity: 'MEDIUM'
      });
    }

    if (/catch\s*\(\s*Exception\s+\w+\s*\)/.test(code)) {
      issues.push({
        type: 'GENERIC_CATCH',
        description: 'Catching generic Exception',
        severity: 'LOW'
      });
    }

    if (/\.printStackTrace\s*\(\s*\)/.test(code)) {
      issues.push({
        type: 'PRINT_STACK_TRACE',
        description: 'Using printStackTrace() instead of proper logging',
        severity: 'LOW'
      });
    }

    return issues;
  }

  analyzeLoopsRegex(code) {
    const loopInfo = {
      forCount: (code.match(/\bfor\s*\(/g) || []).length,
      whileCount: (code.match(/\bwhile\s*\(/g) || []).length,
      doWhileCount: (code.match(/\bdo\s*\{/g) || []).length,
      hasDbCallInLoop: false,
      hasNestedLoop: false
    };

    loopInfo.hasDbCallInLoop = this.detectDbCallInLoop(code);
    loopInfo.hasNestedLoop = this.detectNestedLoop(code);

    return loopInfo;
  }

  detectDbCallInLoop(code) {
    const loopPattern = /(?:for|while)\s*\([^)]*\)\s*\{/g;
    let match;

    while ((match = loopPattern.exec(code)) !== null) {
      const startIndex = match.index + match[0].length;
      const loopBlock = this.extractBlock(code, startIndex);

      const dbPatterns = [
        /\.executeQuery\s*\(/,
        /\.executeUpdate\s*\(/,
        /\.execute\s*\(/,
        /\.prepareStatement\s*\(/,
        /\.getConnection\s*\(/
      ];

      for (const pattern of dbPatterns) {
        if (pattern.test(loopBlock)) {
          return true;
        }
      }
    }

    return false;
  }

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

  // ═══════════════════════════════════════════════════════════════════════════════
  // AST 시그니처 생성 (기존 로직)
  // ═══════════════════════════════════════════════════════════════════════════════

  generateASTSignature(analysis) {
    const structural = this.generateStructuralSignature(analysis);
    const semantic = this.generateSemanticSignature(analysis);
    const behavioral = this.generateBehavioralSignature(analysis);

    return {
      structural,
      semantic,
      behavioral,
      combined: `${structural}|${semantic}|${behavioral}`
    };
  }

  generateStructuralSignature(analysis) {
    const parts = [
      `depth:${analysis.maxDepth || 0}`,
      `complexity:${analysis.cyclomaticComplexity || 0}`,
      `methods:${(analysis.methodDeclarations || []).length}`,
      `classes:${(analysis.classDeclarations || []).length}`
    ];
    return parts.join(',');
  }

  generateSemanticSignature(analysis) {
    const parts = [];

    const annotations = (analysis.annotations || []).map(a => `@${a.name || a}`).join(',');
    if (annotations) parts.push(`ann:${annotations}`);

    const resources = this.generateResourcePattern(analysis.resourceLifecycles || []);
    if (resources) parts.push(`res:${resources}`);

    // [Fix #3] exceptionHandlingIssues 사용 (기존 배열 필드)
    const exceptions = this.generateExceptionPattern(analysis.exceptionHandlingIssues || []);
    if (exceptions) parts.push(`exc:${exceptions}`);

    return parts.join('|') || 'none';
  }

  generateBehavioralSignature(analysis) {
    const parts = [];

    const methodCalls = this.generateMethodCallPattern(analysis.methodInvocations || []);
    if (methodCalls) parts.push(`calls:${methodCalls}`);

    const controlFlow = this.generateControlFlowPattern(analysis.controlStructures || []);
    if (controlFlow) parts.push(`flow:${controlFlow}`);

    // [Fix #3] securityIssues 사용 (기존 배열 필드)
    const security = this.generateSecurityPattern(analysis.securityIssues || []);
    if (security) parts.push(`sec:${security}`);

    return parts.join('|') || 'none';
  }

  generateResourcePattern(resourceLifecycles) {
    if (!resourceLifecycles || !Array.isArray(resourceLifecycles)) return '';
    return resourceLifecycles.map(r => {
      const stage = r.inTryWithResources ? 'auto' : (r.hasCloseCall ? 'manual' : 'leaked');
      return `${r.type}:${stage}`;
    }).join(',');
  }

  generateSecurityPattern(securityPatterns) {
    if (!securityPatterns || !Array.isArray(securityPatterns)) return '';
    return securityPatterns.map(p => p.type || p).join(',');
  }

  generateFrameworkPattern(annotations, classDeclarations) {
    const patterns = [];

    if (annotations && Array.isArray(annotations)) {
      patterns.push(...annotations.map(a => `@${a.name || a}`));
    }

    if (classDeclarations && Array.isArray(classDeclarations)) {
      for (const cls of classDeclarations) {
        if (cls.extends) {
          patterns.push(`extends:${cls.extends}`);
        }
        if (cls.implements && cls.implements.length > 0) {
          patterns.push(...cls.implements.map(i => `implements:${i}`));
        }
      }
    }

    return patterns.join(',');
  }

  generateMethodCallPattern(methodInvocations) {
    if (!methodInvocations || !Array.isArray(methodInvocations)) return '';
    return methodInvocations
      .slice(0, 5)
      .map(m => `${m.target || 'this'}.${m.method}`)
      .join('->');
  }

  generateControlFlowPattern(controlStructures) {
    if (!controlStructures || !Array.isArray(controlStructures)) return '';
    return controlStructures.map(cs => cs.type || cs).join('->');
  }

  generateExceptionPattern(exceptionHandling) {
    if (!exceptionHandling || !Array.isArray(exceptionHandling)) return '';
    return exceptionHandling.map(eh => eh.type || eh).join(',');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton & Export
// ═══════════════════════════════════════════════════════════════════════════════

let instance = null;

export function getJavaAstParser() {
  if (!instance) {
    instance = new JavaASTParser();
  }
  return instance;
}

export function resetJavaAstParser() {
  instance = null;
}

// 하위 호환을 위한 alias
export { JavaASTParser as JavaAstParser };

export default JavaASTParser;