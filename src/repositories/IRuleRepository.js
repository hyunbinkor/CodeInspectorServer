/**
 * Rule Repository 인터페이스
 * 
 * DB 추상화를 위한 인터페이스 정의
 * Qdrant, PostgreSQL 등 다양한 구현체로 교체 가능
 * 
 * @module repositories/IRuleRepository
 */

/**
 * @typedef {Object} Rule
 * @property {string} ruleId - 규칙 고유 ID
 * @property {string} title - 규칙 제목
 * @property {string} description - 상세 설명
 * @property {string} category - 카테고리
 * @property {string} severity - 심각도 (CRITICAL, HIGH, MEDIUM, LOW)
 * @property {string} checkType - 검사 타입 (pure_regex, llm_with_regex, llm_contextual, llm_with_ast)
 * @property {string[]} requiredTags - 필수 태그
 * @property {string[]} excludeTags - 제외 태그
 * @property {string} tagCondition - 태그 조건 표현식
 * @property {string} message - 위반 메시지
 * @property {string} suggestion - 개선 제안
 * @property {boolean} isActive - 활성화 여부
 */

/**
 * Rule Repository 인터페이스
 * 
 * @interface IRuleRepository
 */
export class IRuleRepository {
  /**
   * 초기화
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('Method not implemented: initialize()');
  }

  /**
   * 전체 규칙 조회
   * @param {Object} filters - 필터 조건
   * @returns {Promise<Rule[]>}
   */
  async findAll(filters = {}) {
    throw new Error('Method not implemented: findAll()');
  }

  /**
   * ID로 규칙 조회
   * @param {string} ruleId - 규칙 ID
   * @returns {Promise<Rule|null>}
   */
  async findById(ruleId) {
    throw new Error('Method not implemented: findById()');
  }

  /**
   * 태그 기반 규칙 조회
   * @param {string[]} tags - 태그 배열
   * @param {Object} options - 조회 옵션
   * @returns {Promise<Rule[]>}
   */
  async findByTags(tags, options = {}) {
    throw new Error('Method not implemented: findByTags()');
  }

  /**
   * 단일 규칙 저장
   * @param {Rule} rule - 규칙 객체
   * @returns {Promise<Rule>}
   */
  async save(rule) {
    throw new Error('Method not implemented: save()');
  }

  /**
   * 전체 규칙 저장 (배치)
   * @param {Rule[]} rules - 규칙 배열
   * @returns {Promise<{success: number, failed: number}>}
   */
  async saveAll(rules) {
    throw new Error('Method not implemented: saveAll()');
  }

  /**
   * 규칙 삭제
   * @param {string} ruleId - 규칙 ID
   * @returns {Promise<boolean>}
   */
  async delete(ruleId) {
    throw new Error('Method not implemented: delete()');
  }

  /**
   * 전체 규칙 삭제
   * @returns {Promise<void>}
   */
  async deleteAll() {
    throw new Error('Method not implemented: deleteAll()');
  }

  /**
   * 규칙 개수 조회
   * @returns {Promise<number>}
   */
  async count() {
    throw new Error('Method not implemented: count()');
  }

  /**
   * 통계 조회
   * @returns {Promise<Object>}
   */
  async getStats() {
    throw new Error('Method not implemented: getStats()');
  }
}

export default IRuleRepository;
