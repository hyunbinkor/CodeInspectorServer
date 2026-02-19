/**
 * Tag Repository 인터페이스
 * 
 * 태그 정의 관리를 위한 인터페이스
 * 현재는 JSON 파일 기반이지만, 추후 DB로 교체 가능
 * 
 * @module repositories/ITagRepository
 */

/**
 * @typedef {Object} TagDefinition
 * @property {string} name - 태그 이름
 * @property {string} category - 카테고리
 * @property {string} description - 설명
 * @property {string} extractionMethod - 추출 방식 (regex, ast, llm)
 * @property {number} tier - 티어 (1: 빠른 추출, 2: LLM 필요)
 * @property {Object} detection - 검출 설정
 */

/**
 * Tag Repository 인터페이스
 * 
 * @interface ITagRepository
 */
export class ITagRepository {
  /**
   * 초기화
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('Method not implemented: initialize()');
  }

  /**
   * 전체 태그 정의 조회
   * @returns {Promise<TagDefinition[]>}
   */
  async findAll() {
    throw new Error('Method not implemented: findAll()');
  }

  /**
   * 이름으로 태그 조회
   * @param {string} name - 태그 이름
   * @returns {Promise<TagDefinition|null>}
   */
  async findByName(name) {
    throw new Error('Method not implemented: findByName()');
  }

  /**
   * 카테고리별 태그 조회
   * @param {string} category - 카테고리
   * @returns {Promise<TagDefinition[]>}
   */
  async findByCategory(category) {
    throw new Error('Method not implemented: findByCategory()');
  }

  /**
   * 태그 저장
   * @param {TagDefinition} tag - 태그 정의
   * @returns {Promise<TagDefinition>}
   */
  async save(tag) {
    throw new Error('Method not implemented: save()');
  }

  /**
   * 전체 태그 저장 (배치)
   * @param {TagDefinition[]} tags - 태그 정의 배열
   * @returns {Promise<{success: number, failed: number}>}
   */
  async saveAll(tags) {
    throw new Error('Method not implemented: saveAll()');
  }

  /**
   * 태그 삭제
   * @param {string} name - 태그 이름
   * @returns {Promise<boolean>}
   */
  async delete(name) {
    throw new Error('Method not implemented: delete()');
  }

  /**
   * 전체 태그 삭제
   * @returns {Promise<void>}
   */
  async deleteAll() {
    throw new Error('Method not implemented: deleteAll()');
  }

  /**
   * 복합 태그 조회
   * @returns {Promise<Object[]>}
   */
  async findCompoundTags() {
    throw new Error('Method not implemented: findCompoundTags()');
  }

  /**
   * 메타데이터 조회
   * @returns {Promise<Object>}
   */
  async getMetadata() {
    throw new Error('Method not implemented: getMetadata()');
  }
}

export default ITagRepository;
