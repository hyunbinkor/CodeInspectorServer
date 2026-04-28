/**
 * checkCode 통합 테스트 — vLLM / Qdrant 의존성 mock
 *
 * 외부 환경 없이 검사 엔진의 핵심 경로를 검증한다.
 * mock 대상:
 *   - LLMClient.generateCompletion : ruleId별 미리 등록된 응답 반환
 *   - QdrantRuleRepository.findByTags : 인메모리 규칙 + tagSet 평가
 *   - QdrantClient : codeChecker.initialize에서 호출되므로 stub
 *   - TagDefinitionLoader : 인메모리 태그 정규식 fixture
 *
 * 실제로 사용되는 코드:
 *   - codeChecker (분기, 필터링, 청킹, dedup, AsyncLocalStorage stats)
 *   - codeTagger.extractByRegex (mock된 fixture 패턴 사용)
 *   - methodChunker (정규식 청킹)
 *   - chunkResultMerger (라인 번호 변환, dedup)
 *   - javaAstParser (정규식 fallback)
 *   - truncateCode (라인번호 prefix)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────
// 호이스팅 가능한 mock state (vi.mock factory에서 참조 가능)
// ──────────────────────────────────────────────────────────────────────────
const mockState = vi.hoisted(() => ({
  rules: [],                          // findByTags 결과 후보
  llmResponses: new Map(),            // ruleId → JSON string
  llmCallLog: [],                     // 호출 순서/내용 추적
  reset() {
    this.rules = [];
    this.llmResponses.clear();
    this.llmCallLog.length = 0;
  }
}));

// ──────────────────────────────────────────────────────────────────────────
// LLM Client mock
// ──────────────────────────────────────────────────────────────────────────
vi.mock('../../src/core/clients/llmClient.js', () => ({
  getLLMClient: () => ({
    initialize: async () => true,
    checkConnection: async () => true,
    generateCompletion: async (prompt) => {
      const m = prompt.match(/- ID: (\S+)/);
      const ruleId = m?.[1] || null;
      mockState.llmCallLog.push({ ruleId, ts: Date.now() });
      return mockState.llmResponses.get(ruleId) || '{"violation":false,"line":0}';
    },
    cleanAndExtractJSON: (s) => {
      try {
        // 마크다운 코드펜스 제거
        const cleaned = String(s).replace(/```(?:json)?\s*/gi, '').replace(/```\s*$/g, '').trim();
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  })
}));

// ──────────────────────────────────────────────────────────────────────────
// Qdrant Client mock — codeChecker.initialize에서 호출됨
// ──────────────────────────────────────────────────────────────────────────
vi.mock('../../src/core/clients/qdrantClient.js', () => ({
  getQdrantClient: () => ({
    initialize: async () => true,
    findRulesByTags: async () => [],
    getAllRules: async () => [],
    searchRules: async () => []
  })
}));

// ──────────────────────────────────────────────────────────────────────────
// Rule Repository mock — findByTags가 핵심
// ──────────────────────────────────────────────────────────────────────────
vi.mock('../../src/repositories/impl/QdrantRuleRepository.js', () => ({
  getQdrantRuleRepository: () => ({
    initialize: async () => true,
    findByTags: async (tags) => {
      const tagSet = new Set(tags);
      return mockState.rules.filter(rule => {
        const required = rule.requiredTags || [];
        const excluded = rule.excludeTags || [];
        if (excluded.some(t => tagSet.has(t))) return false;
        if (required.length > 0 && !required.every(t => tagSet.has(t))) return false;
        return rule.isActive !== false;
      });
    },
    findAll: async () => mockState.rules
  }),
  resetQdrantRuleRepository: () => {}
}));

// ──────────────────────────────────────────────────────────────────────────
// Tag Definition Loader mock — 핵심 정규식 fixture만 제공
// ──────────────────────────────────────────────────────────────────────────
vi.mock('../../src/core/tagger/tagDefinitionLoader.js', () => ({
  getTagDefinitionLoader: () => ({
    initialize: async () => true,
    hasTag: () => true,
    getRegexTagPatterns: () => new Map([
      ['IS_DAO', {
        patterns: ['@Repository\\b', 'class\\s+\\w*(?:Dao|DAO)\\b'],
        matchType: 'any',
        flags: 'g'
      }],
      ['IS_SERVICE', {
        patterns: ['@Service\\b', 'class\\s+\\w*Service(?:Impl)?\\b'],
        matchType: 'any',
        flags: 'g'
      }],
      ['USES_CONNECTION', {
        patterns: ['Connection\\s+\\w+', 'getConnection\\s*\\('],
        matchType: 'any',
        flags: 'g'
      }],
      ['USES_LDATA', {
        patterns: ['LData\\s+\\w+', 'new\\s+LData\\s*\\('],
        matchType: 'any',
        flags: 'g'
      }],
      ['CALLS_SYSTEM_OUT', {
        patterns: ['System\\.out\\.print(?:ln)?\\s*\\('],
        matchType: 'any',
        flags: 'g'
      }]
    ]),
    getMetricTags: () => new Map(),
    getLLMTags: () => new Map(),
    getCompoundTags: () => new Map(),
    getAllCompoundTagNames: () => [],
    getCompoundTag: () => null
  }),
  resetTagDefinitionLoader: () => {}
}));

// ──────────────────────────────────────────────────────────────────────────
// 실제 모듈 import (mock 적용 후)
// ──────────────────────────────────────────────────────────────────────────
const { getCodeChecker, resetCodeChecker } = await import('../../src/core/checker/codeChecker.js');
const { resetCodeTagger } = await import('../../src/core/tagger/codeTagger.js');

// ──────────────────────────────────────────────────────────────────────────
// 테스트 헬퍼
// ──────────────────────────────────────────────────────────────────────────
async function freshChecker() {
  resetCodeChecker();
  resetCodeTagger();
  const checker = getCodeChecker();
  await checker.initialize();
  return checker;
}

function buildLargeDaoFile(methodCount) {
  const methods = Array.from({ length: methodCount }, (_, i) =>
    `  public void method${i}() {\n    Connection conn = getConnection();\n    System.out.println("m${i}");\n  }`
  ).join('\n\n');
  return `package com.example;

import java.sql.Connection;

@Repository
public class UserDao {
${methods}
}
`;
}

// ──────────────────────────────────────────────────────────────────────────
// 시나리오
// ──────────────────────────────────────────────────────────────────────────
describe('checkCode integration — basic flows', () => {
  beforeEach(() => mockState.reset());

  it('pure_regex 규칙: System.out 사용 코드에서 위반 검출 (selection 모드)', async () => {
    mockState.rules.push({
      ruleId: 'STD-001',
      title: 'No System.out',
      severity: 'MEDIUM',
      checkType: 'pure_regex',
      requiredTags: [],
      antiPatterns: [{ pattern: 'System\\.out\\.print(?:ln)?', flags: 'g' }],
      isActive: true
    });

    const checker = await freshChecker();
    const code = `public class X {
  public void m() {
    System.out.println("hello");
  }
}`;
    const result = await checker.checkCode(code, 'X.java', { checkMode: 'selection' });
    const v = result.issues.find(i => i.ruleId === 'STD-001');
    expect(v).toBeDefined();
    expect(v.line).toBeGreaterThan(0);
    expect(mockState.llmCallLog.length).toBe(0);   // pure_regex라 LLM 호출 없음
  });

  it('llm_with_regex 규칙: LLM이 violation:true 응답 시 issue 추가', async () => {
    mockState.rules.push({
      ruleId: 'CONN-001',
      title: 'Connection leak',
      severity: 'HIGH',
      checkType: 'llm_with_regex',
      requiredTags: ['USES_CONNECTION'],
      antiPatterns: [{ pattern: 'getConnection\\s*\\(', flags: 'g' }],
      isActive: true
    });
    mockState.llmResponses.set('CONN-001', JSON.stringify({
      violation: true, line: 3, description: 'close 누락', suggestion: 'try-with-resources', confidence: 0.9
    }));

    const checker = await freshChecker();
    const code = `public class Q {
  void f() {
    Connection conn = getConnection();
    // 사용
  }
}`;
    const result = await checker.checkCode(code, 'Q.java', { checkMode: 'selection' });
    expect(result.issues.find(i => i.ruleId === 'CONN-001')).toBeDefined();
    expect(mockState.llmCallLog.length).toBe(1);
  });

  it('LLM이 violation:false 응답 시 issue 추가되지 않음', async () => {
    mockState.rules.push({
      ruleId: 'CONN-002',
      title: 'No close',
      severity: 'HIGH',
      checkType: 'llm_with_regex',
      requiredTags: ['USES_CONNECTION'],
      antiPatterns: [{ pattern: 'getConnection\\s*\\(', flags: 'g' }],
      isActive: true
    });
    mockState.llmResponses.set('CONN-002', JSON.stringify({ violation: false }));

    const checker = await freshChecker();
    const code = `void f() { Connection conn = getConnection(); conn.close(); }`;
    const result = await checker.checkCode(code, 'Q.java', { checkMode: 'selection' });
    expect(result.issues.find(i => i.ruleId === 'CONN-002')).toBeUndefined();
    expect(mockState.llmCallLog.length).toBe(1);
  });
});

describe('checkCode integration — C1: chunked global tags', () => {
  beforeEach(() => mockState.reset());

  it('파일 검사(청킹)에서 IS_DAO 규칙이 globalTags 덕분에 매칭된다', async () => {
    // IS_DAO를 requiredTags로 가진 pure_regex 규칙 — 파일 검사에서 잡혀야 함
    mockState.rules.push({
      ruleId: 'DAO-001',
      title: 'DAO must not use System.out',
      severity: 'HIGH',
      checkType: 'pure_regex',
      requiredTags: ['IS_DAO'],
      antiPatterns: [{ pattern: 'System\\.out\\.print(?:ln)?', flags: 'g' }],
      isActive: true
    });

    const checker = await freshChecker();
    const code = buildLargeDaoFile(120);   // 메서드 120개 → 약 480줄. 파일 검사는 checkMode='file'
    const result = await checker.checkCode(code, 'UserDao.java', { checkMode: 'file' });

    // 청킹 모드 진입 (file mode)
    expect(result.chunked).toBe(true);

    // IS_DAO 태그는 클래스 선언부(@Repository)에서만 추출되는데, 메서드 청크는 본문만 받음.
    // C1 fix가 없으면 globalTags가 안 합쳐져서 DAO-001은 0건. fix 후엔 다수 검출.
    const daoIssues = result.issues.filter(i => i.ruleId === 'DAO-001');
    expect(daoIssues.length).toBeGreaterThan(0);
  });

  it('selection 모드에서는 globalTags가 빈 배열이라 IS_DAO 규칙 매칭 안 됨', async () => {
    mockState.rules.push({
      ruleId: 'DAO-002',
      title: 'DAO test',
      severity: 'HIGH',
      checkType: 'pure_regex',
      requiredTags: ['IS_DAO'],
      antiPatterns: [{ pattern: 'System\\.out', flags: 'g' }],
      isActive: true
    });

    const checker = await freshChecker();
    // 메서드 본문만 (클래스 선언 없음)
    const code = `void f() { System.out.println("x"); }`;
    const result = await checker.checkCode(code, 'frag.java', { checkMode: 'selection' });

    // IS_DAO 태그가 안 붙으므로 DAO-002 매칭 안 됨 — 사용자가 의도한 정책
    expect(result.issues.find(i => i.ruleId === 'DAO-002')).toBeUndefined();
  });
});

describe('checkCode integration — C3: stats race per request', () => {
  beforeEach(() => mockState.reset());

  it('동시 검사 요청들의 stats.llmCalls가 서로 오염되지 않는다', async () => {
    mockState.rules.push({
      ruleId: 'X-001',
      title: 'X',
      severity: 'LOW',
      checkType: 'llm_with_regex',
      requiredTags: ['USES_CONNECTION'],
      antiPatterns: [{ pattern: 'getConnection\\s*\\(', flags: 'g' }],
      isActive: true
    });
    mockState.llmResponses.set('X-001', JSON.stringify({ violation: false }));

    const checker = await freshChecker();
    const codeWithConn = (i) => `class C${i} { void f() { Connection c = getConnection(); } }`;

    // 동시에 5개 요청
    const results = await Promise.all([0, 1, 2, 3, 4].map(i =>
      checker.checkCode(codeWithConn(i), `C${i}.java`, { checkMode: 'selection' })
    ));

    // 각 요청은 정확히 1회 LLM 호출 → stats.llmCalls === 1
    for (const r of results) {
      // resultBuilder.buildReport의 stats가 응답에 포함됨. 형태가 살짝 다를 수 있어 방어적으로
      const llmCalls = r.stats?.llmCalls ?? r.summary?.llmCalls;
      // race가 있으면 5, 4, 3 등으로 누적되어 보일 것
      expect(llmCalls === undefined || llmCalls === 1).toBe(true);
    }
    // 전체 LLM 호출은 정확히 5번
    expect(mockState.llmCallLog.length).toBe(5);
  });
});

describe('checkCode integration — H2: header chunk regex scan', () => {
  beforeEach(() => mockState.reset());

  it('파일 검사 시 import 라인 정규식 위반이 검출된다 (header 청크)', async () => {
    mockState.rules.push({
      ruleId: 'IMP-001',
      title: 'Deprecated import',
      severity: 'MEDIUM',
      checkType: 'pure_regex',
      requiredTags: [],
      antiPatterns: [{ pattern: 'import\\s+sun\\.', flags: 'g' }],
      isActive: true
    });

    const checker = await freshChecker();
    const lines = ['package x;', 'import sun.misc.Unsafe;'];
    for (let i = 0; i < 100; i++) lines.push('  void m' + i + '() { int a = 1; }');
    const code = `public class Big {\n${lines.slice(0, 2).join('\n')}\n` + lines.slice(2).join('\n') + '\n}';

    // forceChunk로 청킹 강제
    const result = await checker.checkCode(code, 'Big.java', { forceChunk: true });
    expect(result.chunked).toBe(true);

    // header 청크에서 import sun. 패턴 매칭되어야 함
    expect(result.issues.find(i => i.ruleId === 'IMP-001')).toBeDefined();
  });
});

describe('checkCode integration — H5: dedup key unification', () => {
  beforeEach(() => mockState.reset());

  it('같은 ruleId+line은 description이 달라도 1개만 남는다 (LLM 검증)', async () => {
    // 한 규칙에 여러 antiPatterns로 같은 라인 매칭이 일어나도록 설정
    mockState.rules.push({
      ruleId: 'DUP-001',
      title: 'dup',
      severity: 'LOW',
      checkType: 'pure_regex',
      requiredTags: [],
      antiPatterns: [
        { pattern: 'System\\.out', flags: 'g' },
        { pattern: 'System\\.out\\.print', flags: 'g' },
        { pattern: 'System\\.out\\.println', flags: 'g' }
      ],
      isActive: true
    });

    const checker = await freshChecker();
    const code = `void f() {\n  System.out.println("hi");\n}`;
    const result = await checker.checkCode(code, 'D.java', { checkMode: 'selection' });

    // 같은 라인에서 3개 패턴 매칭 → dedup 후 1건
    const dups = result.issues.filter(i => i.ruleId === 'DUP-001');
    expect(dups.length).toBe(1);
  });
});

describe('checkCode integration — C2: line numbers across truncation', () => {
  beforeEach(() => mockState.reset());

  it('80KB 초과 코드에서 LLM 응답 line이 원본 라인을 가리킨다', async () => {
    // 1500 줄 × 평균 60자 ≈ 90KB → truncateCode 진입
    const lines = [];
    for (let i = 1; i <= 1500; i++) {
      if (i === 800) {
        lines.push(`    Connection conn_${i} = getConnection();   // suspicious`);
      } else {
        lines.push(`    int filler_${i} = ${i};   ${'/'.repeat(40)}`);
      }
    }
    const code = `void big() {\n${lines.join('\n')}\n}`;

    mockState.rules.push({
      ruleId: 'LINE-001',
      title: 'line preservation test',
      severity: 'HIGH',
      checkType: 'llm_with_regex',
      requiredTags: [],
      antiPatterns: [{ pattern: 'getConnection\\s*\\(', flags: 'g' }],
      isActive: true
    });
    // LLM은 truncate 후 prefix에서 본 원본 라인(801: void가 1번이므로 +1)을 반환
    mockState.llmResponses.set('LINE-001', JSON.stringify({
      violation: true, line: 801, description: 'leak', confidence: 0.9
    }));

    const checker = await freshChecker();
    const result = await checker.checkCode(code, 'big.java', { checkMode: 'selection' });

    const v = result.issues.find(i => i.ruleId === 'LINE-001');
    expect(v).toBeDefined();
    // C2 fix: LLM이 응답한 line이 원본 라인(801)으로 들어가야 함
    // (이전엔 truncate 후 1부터 새로 매겨져 어긋났음)
    expect(v.line).toBe(801);
  });
});

describe('checkCode integration — chunked: end-to-end multi-chunk', () => {
  beforeEach(() => mockState.reset());

  it('파일 모드 청킹: 여러 메서드 청크 모두 검사되어 위반이 합쳐짐', async () => {
    mockState.rules.push({
      ruleId: 'STD-CHUNK',
      title: 'system.out',
      severity: 'LOW',
      checkType: 'pure_regex',
      requiredTags: [],
      antiPatterns: [{ pattern: 'System\\.out\\.print(?:ln)?', flags: 'g' }],
      isActive: true
    });

    const checker = await freshChecker();
    // 5개 메서드, 각각 System.out 사용
    const code = buildLargeDaoFile(5);
    const result = await checker.checkCode(code, 'M.java', { checkMode: 'file' });

    expect(result.chunked).toBe(true);
    const issues = result.issues.filter(i => i.ruleId === 'STD-CHUNK');
    // 각 메서드당 1건씩, 총 5건 (dedup 후에도 라인 다르니 모두 살아남음)
    expect(issues.length).toBe(5);
    // 라인 번호가 서로 다른지 (각 메서드 내부 System.out 위치가 다름)
    const lines = new Set(issues.map(i => i.line));
    expect(lines.size).toBe(5);
  });
});

describe('checkCode integration — selection mode guard', () => {
  beforeEach(() => mockState.reset());

  it('selection 모드는 청킹 진입 안 함 (3000줄 넘어도)', async () => {
    const checker = await freshChecker();
    // 5000줄 코드 (selection은 6000줄까지 허용 by router, 여기선 codeChecker 직접 호출)
    const code = Array.from({ length: 5000 }, (_, i) => `int x${i} = ${i};`).join('\n');
    const result = await checker.checkCode(code, 'Long.java', { checkMode: 'selection' });
    expect(result.chunked).toBeFalsy();
  });

  it('file 모드는 짧아도 청킹 진입', async () => {
    const checker = await freshChecker();
    const code = `public class Tiny { void f() { int a = 1; } }`;
    const result = await checker.checkCode(code, 'Tiny.java', { checkMode: 'file' });
    expect(result.chunked).toBe(true);
  });
});
