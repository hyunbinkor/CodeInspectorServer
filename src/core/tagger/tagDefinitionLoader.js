/**
 * 태그 정의 로더 (JSON 기반)
 * 
 * JSON 파일에서 태그 정의를 로드하고 관리
 * - tier 1: 정규식 기반 빠른 태그 추출
 * - tier 2: LLM 기반 컨텍스트 태그 추출
 * - 복합 태그: 기본 태그 조합으로 자동 계산
 * 
 * 변경사항:
 * - [Fix A] getRegexTagPatterns(): flags 반환 추가 (caseSensitive 처리)
 * - [Fix B] getMetricTags(): type==="metric" 뿐 아니라 threshold 필드 존재 시에도 수집
 * - [Qdrant 이전] JSON 파일 직접 읽기 → QdrantTagRepository 통해 조회
 *   기존: /tmp/tags/tag-definitions.json (재시작 시 소멸)
 *   수정: Qdrant 'tag-definitions' 컬렉션 (영속)
 * 
 * @module tagger/tagDefinitionLoader
 */

import fs from 'fs/promises';
import path from 'path';
import { getQdrantTagRepository } from '../../repositories/impl/QdrantTagRepository.js';
import { config } from '../../config/index.js';
import logger from '../../utils/loggerUtils.js';

/** @type {TagDefinitionLoader|null} */
let instance = null;

export class TagDefinitionLoader {
  constructor() {
    // 태그 저장소
    this.tags = new Map();           // tagName → tag 정의
    this.categories = new Map();     // category → [tagNames]
    this.compoundTags = new Map();   // compoundName → compound 정의
    this.triggerConditions = new Map(); // conditionName → condition 정의
    
    // tier별 분류 (성능 최적화)
    this.tier1Tags = new Map();      // regex 기반 (빠름)
    this.tier2Tags = new Map();      // llm 기반 (컨텍스트 필요)
    
    // 메타데이터
    this.metadata = null;
    this.categoryDescriptions = {};
    
    this.initialized = false;
  }

  /**
   * 초기화 - Qdrant에서 태그 정의 로드
   * 
   * [Qdrant 이전] JSON 파일 직접 읽기 → QdrantTagRepository 통해 조회
   * 폴백 순서: Qdrant → 로컬 JSON 파일 → 하드코딩 기본 태그
   */
  async initialize() {
    if (this.initialized) return;

    try {
      // 1차 시도: QdrantTagRepository에서 로드
      const tagRepository = getQdrantTagRepository();
      await tagRepository.initialize();
      const data = await tagRepository.getAllData();

      if (data && data.tags && Object.keys(data.tags).length > 0) {
        this._loadFromData(data);
        this.initialized = true;
        logger.info(`✅ 태그 정의 로드 완료 (Qdrant): ${this.tags.size}개 태그 (tier1: ${this.tier1Tags.size}, tier2: ${this.tier2Tags.size}), ${this.compoundTags.size}개 복합 태그`);
        return;
      }

      logger.warn('Qdrant 태그 데이터 비어있음, 로컬 JSON 폴백 시도');
    } catch (error) {
      logger.warn(`Qdrant 태그 로드 실패, 로컬 JSON 폴백: ${error.message}`);
    }

    // 2차 폴백: 로컬 JSON 파일
    try {
      const tagFilePath = path.join(config.paths.assets.tags, 'tag-definitions.json');
      await fs.access(tagFilePath);
      const content = await fs.readFile(tagFilePath, 'utf-8');
      const data = JSON.parse(content);
      this._loadFromData(data);
      this.initialized = true;
      logger.info(`✅ 태그 정의 로드 완료 (로컬 JSON 폴백): ${this.tags.size}개 태그`);
      return;
    } catch (error) {
      logger.warn(`로컬 JSON 폴백 실패: ${error.message}`);
    }

    // 3차 폴백: 하드코딩 기본 태그
    this.loadDefaultTags();
    this.initialized = true;
  }

  /**
   * 데이터 객체에서 태그 정의 로드 (공통 로직)
   * @private
   * @param {Object} data - tag-definitions 구조의 데이터
   */
  _loadFromData(data) {
    // 기존 데이터 초기화 (리로드 시 중복 방지)
    this.tags.clear();
    this.categories.clear();
    this.compoundTags.clear();
    this.triggerConditions.clear();
    this.tier1Tags.clear();
    this.tier2Tags.clear();

    // 메타데이터 로드
    this.metadata = data._metadata || {};
    this.categoryDescriptions = data.tagCategories || {};

    // 기본 태그 로드
    if (data.tags) {
      for (const [tagName, tagDef] of Object.entries(data.tags)) {
        const tag = { name: tagName, ...tagDef };
        this.tags.set(tagName, tag);
        
        // 카테고리별 분류
        const category = tag.category || 'general';
        if (!this.categories.has(category)) {
          this.categories.set(category, []);
        }
        this.categories.get(category).push(tagName);
        
        // tier별 분류
        if (tag.tier === 1 || tag.extractionMethod === 'regex') {
          this.tier1Tags.set(tagName, tag);
        } else if (tag.tier === 2 || tag.extractionMethod === 'llm') {
          this.tier2Tags.set(tagName, tag);
        } else {
          this.tier1Tags.set(tagName, tag);
        }
      }
    }

    // 복합 태그 로드
    if (data.compoundTags) {
      for (const [compoundName, compoundDef] of Object.entries(data.compoundTags)) {
        this.compoundTags.set(compoundName, { name: compoundName, ...compoundDef });
      }
    }

    // 트리거 조건 로드
    if (data.triggerConditions) {
      for (const [condName, condDef] of Object.entries(data.triggerConditions)) {
        this.triggerConditions.set(condName, { name: condName, ...condDef });
      }
    }
  }

  /**
   * 기본 태그 정의 로드 (JSON 없을 때 폴백)
   */
  loadDefaultTags() {
    const defaultTags = {
      // 리소스 관련 (tier 1)
      'USES_CONNECTION': {
        category: 'resource',
        description: 'DB Connection 사용',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['Connection\\s+\\w+', '\\.getConnection\\s*\\('],
          matchType: 'any'
        }
      },
      'USES_STATEMENT': {
        category: 'resource',
        description: 'Statement 사용',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['Statement\\s+\\w+', 'PreparedStatement\\s+\\w+'],
          matchType: 'any'
        }
      },
      'USES_RESULTSET': {
        category: 'resource',
        description: 'ResultSet 사용',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['ResultSet\\s+\\w+'],
          matchType: 'any'
        }
      },
      'USES_STREAM': {
        category: 'resource',
        description: 'Stream 사용',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['InputStream\\s+\\w+', 'OutputStream\\s+\\w+', 'BufferedReader', 'BufferedWriter'],
          matchType: 'any'
        }
      },
      'HAS_TRY_WITH_RESOURCES': {
        category: 'pattern',
        description: 'try-with-resources 사용',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['try\\s*\\([^)]+\\)\\s*\\{'],
          matchType: 'any'
        }
      },
      'HAS_CLOSE_IN_FINALLY': {
        category: 'pattern',
        description: 'finally에서 close 호출',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['finally\\s*\\{[^}]*\\.close\\s*\\('],
          matchType: 'any'
        }
      },

      // 예외 처리
      'HAS_TRY_CATCH': {
        category: 'pattern',
        description: 'try-catch 블록 존재',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['\\btry\\s*\\{'],
          matchType: 'any'
        }
      },
      'HAS_EMPTY_CATCH': {
        category: 'pattern',
        description: '빈 catch 블록',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['catch\\s*\\([^)]+\\)\\s*\\{\\s*\\}'],
          matchType: 'any'
        }
      },
      'HAS_GENERIC_CATCH': {
        category: 'pattern',
        description: 'catch(Exception e) 사용',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['catch\\s*\\(\\s*Exception\\s+\\w+\\s*\\)'],
          matchType: 'any'
        }
      },

      // 보안
      'HAS_SQL_CONCATENATION': {
        category: 'security',
        description: 'SQL 문자열 연결',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['["\']\\s*\\+\\s*\\w+.*(?:SELECT|INSERT|UPDATE|DELETE|WHERE)'],
          matchType: 'any'
        }
      },
      'HAS_HARDCODED_PASSWORD': {
        category: 'security',
        description: '하드코딩된 비밀번호',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['(?:password|passwd|pwd)\\s*=\\s*["\'][^"\']+["\']'],
          matchType: 'any'
        }
      },
      'USES_PREPARED_STATEMENT': {
        category: 'security',
        description: 'PreparedStatement 사용',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['\\bPreparedStatement\\b', 'prepareStatement\\s*\\('],
          matchType: 'any'
        }
      },

      // 아키텍처
      'IS_CONTROLLER': {
        category: 'structure',
        description: 'Controller 클래스',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['@Controller\\b', '@RestController\\b'],
          matchType: 'any'
        }
      },
      'IS_SERVICE': {
        category: 'structure',
        description: 'Service 클래스',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['@Service\\b'],
          matchType: 'any'
        }
      },
      'IS_DAO': {
        category: 'structure',
        description: 'DAO/Repository 클래스',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['@Repository\\b', 'class\\s+\\w*Dao\\b', 'class\\s+\\w*DAO\\b'],
          matchType: 'any'
        }
      },

      // 성능
      'HAS_DB_CALL_IN_LOOP': {
        category: 'performance',
        description: '루프 내 DB 호출',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['for\\s*\\([^)]*\\)[^{]*\\{[^}]*execute(?:Query|Update)'],
          matchType: 'any'
        }
      },
      'HAS_NESTED_LOOP': {
        category: 'performance',
        description: '중첩 루프',
        tier: 1,
        detection: {
          type: 'regex',
          patterns: ['for\\s*\\([^)]*\\)[^{]*\\{[^}]*for\\s*\\('],
          matchType: 'any'
        }
      },

      // 메트릭
      'LINE_COUNT_HIGH': {
        category: 'metric',
        description: '라인 수 300 이상',
        tier: 1,
        detection: { type: 'metric', threshold: 300, metric: 'lineCount' }
      },
      'METHOD_COUNT_HIGH': {
        category: 'metric',
        description: '메서드 수 10개 이상',
        tier: 1,
        detection: { type: 'metric', threshold: 10, metric: 'methodCount' }
      },
      'COMPLEXITY_HIGH': {
        category: 'metric',
        description: '순환 복잡도 10 이상',
        tier: 1,
        detection: { type: 'metric', threshold: 10, metric: 'complexity' }
      },
      'NESTING_DEEP': {
        category: 'metric',
        description: '중첩 깊이 4 이상',
        tier: 1,
        detection: { type: 'metric', threshold: 4, metric: 'nestingDepth' }
      }
    };

    // 태그 등록
    for (const [tagName, tagDef] of Object.entries(defaultTags)) {
      const tag = { name: tagName, ...tagDef };
      this.tags.set(tagName, tag);
      
      const category = tag.category || 'general';
      if (!this.categories.has(category)) {
        this.categories.set(category, []);
      }
      this.categories.get(category).push(tagName);
      
      this.tier1Tags.set(tagName, tag);
    }

    // 기본 복합 태그
    const defaultCompoundTags = {
      'RESOURCE_LEAK_RISK': {
        expression: '(USES_CONNECTION || USES_STATEMENT || USES_RESULTSET || USES_STREAM) && !HAS_TRY_WITH_RESOURCES && !HAS_CLOSE_IN_FINALLY',
        description: '리소스 누수 위험',
        severity: 'CRITICAL'
      },
      'SQL_INJECTION_RISK': {
        expression: 'HAS_SQL_CONCATENATION && !USES_PREPARED_STATEMENT',
        description: 'SQL 인젝션 위험',
        severity: 'CRITICAL'
      },
      'N_PLUS_ONE_RISK': {
        expression: 'HAS_DB_CALL_IN_LOOP',
        description: 'N+1 쿼리 위험',
        severity: 'HIGH'
      },
      'POOR_ERROR_HANDLING': {
        expression: 'HAS_EMPTY_CATCH || HAS_GENERIC_CATCH',
        description: '부적절한 예외 처리',
        severity: 'MEDIUM'
      }
    };

    for (const [name, def] of Object.entries(defaultCompoundTags)) {
      this.compoundTags.set(name, { name, ...def });
    }

    logger.info(`기본 태그 로드: ${this.tags.size}개 태그, ${this.compoundTags.size}개 복합 태그`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 태그 조회 API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 태그 정의 조회
   * @param {string} tagName - 태그명
   * @returns {Object|null}
   */
  getTag(tagName) {
    return this.tags.get(tagName) || null;
  }

  /**
   * 복합 태그 정의 조회
   * @param {string} compoundName - 복합 태그명
   * @returns {Object|null}
   */
  getCompoundTag(compoundName) {
    return this.compoundTags.get(compoundName) || null;
  }

  /**
   * 카테고리별 태그 목록
   * @param {string} category - 카테고리명
   * @returns {string[]}
   */
  getTagsByCategory(category) {
    return this.categories.get(category) || [];
  }

  /**
   * 전체 태그 목록
   * @returns {string[]}
   */
  getAllTagNames() {
    return Array.from(this.tags.keys());
  }

  /**
   * 전체 복합 태그 목록
   * @returns {string[]}
   */
  getAllCompoundTagNames() {
    return Array.from(this.compoundTags.keys());
  }

  /**
   * 태그 존재 여부
   * @param {string} tagName - 태그명
   * @returns {boolean}
   */
  hasTag(tagName) {
    return this.tags.has(tagName) || this.compoundTags.has(tagName);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tier 기반 API (성능 최적화)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Tier 1 (regex) 태그 목록 반환
   * @returns {Map<string, Object>}
   */
  getTier1Tags() {
    return this.tier1Tags;
  }

  /**
   * Tier 2 (llm) 태그 목록 반환
   * @returns {Map<string, Object>}
   */
  getTier2Tags() {
    return this.tier2Tags;
  }

  /**
   * 태그의 detection 패턴 조회
   * @param {string} tagName - 태그명
   * @returns {Object|null} detection 정보 (patterns, matchType 등)
   */
  getDetection(tagName) {
    const tag = this.tags.get(tagName);
    return tag?.detection || null;
  }

  /**
   * 태그의 정규식 패턴 목록 조회
   * @param {string} tagName - 태그명
   * @returns {string[]} 패턴 문자열 배열
   */
  getPatterns(tagName) {
    const detection = this.getDetection(tagName);
    if (detection?.type === 'regex' && detection.patterns) {
      return detection.patterns;
    }
    return [];
  }

  /**
   * 정규식 기반 태그들과 패턴 반환 (codeTagger용)
   * 
   * [Fix A] flags 반환 추가
   *   - 기존: flags 미반환 → codeTagger에서 항상 'g'만 사용
   *   - 수정: caseSensitive 설정을 flags로 변환하여 반환
   * 
   * @returns {Map<string, Object>} tagName → { patterns: string[], matchType, flags, excludeInComments }
   */
  getRegexTagPatterns() {
    const result = new Map();
    
    for (const [tagName, tag] of this.tier1Tags) {
      if (tag.detection?.type === 'regex' && tag.detection.patterns) {
        // [Fix A] caseSensitive 설정에 따라 flags 결정
        let flags = 'g';
        if (tag.detection.caseSensitive === false) {
          flags = 'gi';
        }

        result.set(tagName, {
          patterns: tag.detection.patterns,
          matchType: tag.detection.matchType || 'any',
          excludeInComments: tag.detection.excludeInComments || false,
          flags  // [Fix A] flags 포함
        });
      }
    }
    
    return result;
  }

  /**
   * 메트릭 기반 태그들과 threshold 반환
   * 
   * [Fix B] threshold 필드 기반으로도 수집
   *   - 기존: detection.type === 'metric'만 수집 → JSON에 type:"ast"인 메트릭 태그 누락
   *   - 수정: threshold와 metric 필드가 있으면 type과 무관하게 메트릭 태그로 인식
   * 
   * @returns {Map<string, Object>} tagName → { metric: string, threshold: number }
   */
  getMetricTags() {
    const result = new Map();
    
    for (const [tagName, tag] of this.tags) {
      // [Fix B] type이 'metric'이거나, threshold와 metric 필드가 모두 존재하면 수집
      if (tag.detection?.type === 'metric' || 
          (tag.detection?.threshold !== undefined && tag.detection?.metric)) {
        result.set(tagName, {
          metric: tag.detection.metric,
          threshold: tag.detection.threshold
        });
      }
    }
    
    return result;
  }

  /**
   * LLM 기반 태그들과 트리거 조건 반환
   * @returns {Map<string, Object>} tagName → { criteria: string, triggerTags: string[] }
   */
  getLLMTags() {
    const result = new Map();
    
    for (const [tagName, tag] of this.tier2Tags) {
      if (tag.detection?.type === 'llm') {
        result.set(tagName, {
          criteria: tag.detection.criteria || tag.description,
          triggerTags: tag.detection.triggerTags || []
        });
      }
    }
    
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 프롬프트 생성 API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 태그 설명 조회 (LLM 프롬프트용)
   * @returns {string}
   */
  getTagDescriptionsForPrompt() {
    const lines = ['사용 가능한 태그 목록:'];
    
    for (const [category, tagNames] of this.categories) {
      const categoryDesc = this.categoryDescriptions[category] || category;
      lines.push(`\n## ${category} (${categoryDesc})`);
      
      for (const tagName of tagNames) {
        const tag = this.tags.get(tagName);
        const tierInfo = tag.tier === 2 ? ' [LLM]' : '';
        lines.push(`- ${tagName}: ${tag.description}${tierInfo}`);
      }
    }

    lines.push('\n## 복합 태그 (자동 계산)');
    for (const [name, compound] of this.compoundTags) {
      lines.push(`- ${name}: ${compound.description}`);
      lines.push(`  조건: ${compound.expression}`);
    }

    return lines.join('\n');
  }

  /**
   * 특정 tier 태그들의 프롬프트 생성
   * @param {number} tier - 1 또는 2
   * @returns {string}
   */
  getTagDescriptionsByTier(tier) {
    const targetMap = tier === 1 ? this.tier1Tags : this.tier2Tags;
    const lines = [`Tier ${tier} 태그 목록:`];
    
    for (const [tagName, tag] of targetMap) {
      lines.push(`- ${tagName}: ${tag.description}`);
    }
    
    return lines.join('\n');
  }
}

/**
 * 싱글톤 인스턴스 반환
 */
export function getTagDefinitionLoader() {
  if (!instance) {
    instance = new TagDefinitionLoader();
  }
  return instance;
}

/**
 * 인스턴스 리셋 (테스트용 / Push 후 리로드용)
 */
export function resetTagDefinitionLoader() {
  instance = null;
}

export default TagDefinitionLoader;