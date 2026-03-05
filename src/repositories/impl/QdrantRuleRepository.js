/**
 * Qdrant Rule Repository 구현체
 * 
 * 기존 qdrantClient.js를 IRuleRepository 인터페이스로 래핑
 * DB 교체 시 이 파일만 다른 구현체로 교체하면 됨
 * 
 * @module repositories/impl/QdrantRuleRepository
 */

import { IRuleRepository } from '../IRuleRepository.js';
import { getQdrantClient } from '../../core/clients/qdrantClient.js';
import logger from '../../utils/loggerUtils.js';

export class QdrantRuleRepository extends IRuleRepository {
  constructor() {
    super();
    this.qdrantClient = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
  
    // 기존 가이드라인 컬렉션 클라이언트
    this.qdrantClient = getQdrantClient();
    await this.qdrantClient.initialize();
  
    // ✅ 이슈 컬렉션 클라이언트 (컬렉션명만 다르게)
    const issueCollectionName = config.qdrant.issueCollectionName;
    if (issueCollectionName && issueCollectionName !== config.qdrant.collectionName) {
      this.issueQdrantClient = getQdrantClient({ 
        ...config.qdrant, 
        collectionName: issueCollectionName 
      });
      // 컬렉션이 없을 수도 있으니 소프트하게 초기화
      try {
        await this.issueQdrantClient.initialize();
        logger.info(`✅ 이슈 컬렉션 연결: ${issueCollectionName}`);
      } catch (e) {
        logger.warn(`⚠️ 이슈 컬렉션 없음, 스킵: ${issueCollectionName}`);
        this.issueQdrantClient = null;
      }
    }
  
    this.initialized = true;
  }
  
  async findAll(filters = {}) {
    await this.ensureInitialized();
  
    // ✅ 두 컬렉션 병렬 조회 후 합산
    const [guidelineRules, issueRules] = await Promise.all([
      this.qdrantClient.getAllRules(filters),
      this.issueQdrantClient 
        ? this.issueQdrantClient.getAllRules(filters).catch(e => {
            logger.warn(`이슈 컬렉션 조회 실패, 빈 배열 반환: ${e.message}`);
            return [];
          })
        : Promise.resolve([])
    ]);
  
    const merged = [...guidelineRules, ...issueRules];
    logger.info(`[Repository] 전체 규칙: 가이드라인 ${guidelineRules.length}개 + 이슈 ${issueRules.length}개 = ${merged.length}개`);
  
    return merged;
  }

  /**
   * ID로 규칙 조회
   */
  async findById(ruleId) {
    await this.ensureInitialized();
    const rules = await this.qdrantClient.searchRules({ ruleId });
    return rules.length > 0 ? rules[0] : null;
  }

  /**
   * 태그 기반 규칙 조회
   */
  async findByTags(tags, options = {}) {
    await this.ensureInitialized();
    return this.qdrantClient.findRulesByTags(tags, options);
  }

  /**
   * 단일 규칙 저장
   */
  async save(rule) {
    await this.ensureInitialized();
    await this.qdrantClient.storeRule(rule);
    return rule;
  }

  /**
   * 전체 규칙 저장 (배치)
   */
  async saveAll(rules) {
    await this.ensureInitialized();
    
    let success = 0;
    let failed = 0;

    for (const rule of rules) {
      try {
        await this.qdrantClient.storeRule(rule);
        success++;
      } catch (error) {
        logger.warn(`규칙 저장 실패 (${rule.ruleId}): ${error.message}`);
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * 규칙 삭제
   */
  async delete(ruleId) {
    await this.ensureInitialized();
    try {
      await this.qdrantClient.deleteRule(ruleId);
      return true;
    } catch (error) {
      logger.error(`규칙 삭제 실패 (${ruleId}): ${error.message}`);
      return false;
    }
  }

  /**
   * 전체 규칙 삭제
   */
  async deleteAll() {
    await this.ensureInitialized();
    await this.qdrantClient.clearCollection();
  }

  /**
   * 규칙 개수 조회
   */
  async count() {
    await this.ensureInitialized();
    const stats = await this.qdrantClient.getCollectionStats();
    return stats?.pointsCount || 0;
  }

  /**
   * 통계 조회
   */
  async getStats() {
    await this.ensureInitialized();
    return this.qdrantClient.getCollectionStats();
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

export function getQdrantRuleRepository() {
  if (!instance) {
    instance = new QdrantRuleRepository();
  }
  return instance;
}

export function resetQdrantRuleRepository() {
  instance = null;
}

export default QdrantRuleRepository;
