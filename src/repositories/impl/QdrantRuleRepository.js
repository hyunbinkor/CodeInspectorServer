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

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    this.qdrantClient = getQdrantClient();
    await this.qdrantClient.initialize();
    
    this.initialized = true;
    logger.info('✅ QdrantRuleRepository 초기화 완료');
  }

  /**
   * 전체 규칙 조회
   */
  async findAll(filters = {}) {
    await this.ensureInitialized();
    return this.qdrantClient.getAllRules(filters);
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
