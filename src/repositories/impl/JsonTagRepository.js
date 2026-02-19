/**
 * JSON 기반 Tag Repository 구현체
 * 
 * 태그 정의를 JSON 파일로 관리
 * Pull/Push 방식으로 전체 데이터 동기화
 * 
 * @module repositories/impl/JsonTagRepository
 */

import fs from 'fs/promises';
import path from 'path';
import { ITagRepository } from '../ITagRepository.js';
import { config } from '../../config/index.js';
import logger from '../../utils/loggerUtils.js';

export class JsonTagRepository extends ITagRepository {
  constructor() {
    super();
    this.filePath = path.join(config.paths.assets.tags, 'tag-definitions.json');
    this.data = null;
    this.initialized = false;
  }

  /**
   * 초기화 - JSON 파일 로드
   */
  async initialize() {
    if (this.initialized) return;

    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(content);
      this.initialized = true;
      logger.info(`✅ JsonTagRepository 초기화 완료: ${Object.keys(this.data.tags || {}).length}개 태그`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 파일 없으면 빈 구조 생성
        this.data = {
          _metadata: {
            version: '1.0.0',
            description: 'Java 코드 프로파일링용 태그 정의',
            lastUpdated: new Date().toISOString(),
            totalTags: 0
          },
          tagCategories: {},
          tags: {},
          compoundTags: {},
          triggerConditions: {}
        };
        this.initialized = true;
        logger.warn('태그 정의 파일 없음, 빈 구조 생성');
      } else {
        logger.error('태그 정의 로드 실패:', error.message);
        throw error;
      }
    }
  }

  /**
   * 전체 태그 정의 조회
   */
  async findAll() {
    await this.ensureInitialized();
    
    const tags = [];
    for (const [name, def] of Object.entries(this.data.tags || {})) {
      tags.push({ name, ...def });
    }
    return tags;
  }

  /**
   * 이름으로 태그 조회
   */
  async findByName(name) {
    await this.ensureInitialized();
    
    const def = this.data.tags?.[name];
    return def ? { name, ...def } : null;
  }

  /**
   * 카테고리별 태그 조회
   */
  async findByCategory(category) {
    await this.ensureInitialized();
    
    const tags = [];
    for (const [name, def] of Object.entries(this.data.tags || {})) {
      if (def.category === category) {
        tags.push({ name, ...def });
      }
    }
    return tags;
  }

  /**
   * 태그 저장
   */
  async save(tag) {
    await this.ensureInitialized();
    
    const { name, ...rest } = tag;
    this.data.tags[name] = rest;
    
    // 파일에 저장하지 않음 (Push에서 일괄 저장)
    return tag;
  }

  /**
   * 전체 태그 저장 (배치)
   */
  async saveAll(tags) {
    await this.ensureInitialized();
    
    let success = 0;
    let failed = 0;

    for (const tag of tags) {
      try {
        const { name, ...rest } = tag;
        this.data.tags[name] = rest;
        success++;
      } catch (error) {
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * 태그 삭제
   */
  async delete(name) {
    await this.ensureInitialized();
    
    if (this.data.tags?.[name]) {
      delete this.data.tags[name];
      return true;
    }
    return false;
  }

  /**
   * 전체 태그 삭제
   */
  async deleteAll() {
    await this.ensureInitialized();
    this.data.tags = {};
  }

  /**
   * 복합 태그 조회
   */
  async findCompoundTags() {
    await this.ensureInitialized();
    
    const compounds = [];
    for (const [name, def] of Object.entries(this.data.compoundTags || {})) {
      compounds.push({ name, ...def });
    }
    return compounds;
  }

  /**
   * 메타데이터 조회
   */
  async getMetadata() {
    await this.ensureInitialized();
    return this.data._metadata || {};
  }

  /**
   * 전체 데이터 조회 (Pull용)
   */
  async getAllData() {
    await this.ensureInitialized();
    return {
      ...this.data,
      _metadata: {
        ...this.data._metadata,
        lastUpdated: new Date().toISOString(),
        totalTags: Object.keys(this.data.tags || {}).length
      }
    };
  }

  /**
   * 전체 데이터 교체 (Push용)
   */
  async replaceAllData(newData) {
    // 메타데이터 업데이트
    newData._metadata = {
      ...newData._metadata,
      lastUpdated: new Date().toISOString(),
      totalTags: Object.keys(newData.tags || {}).length
    };

    this.data = newData;
    
    // 파일에 저장
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    
    logger.info(`✅ 태그 정의 저장 완료: ${this.filePath}`);
    return this.data;
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

export function getJsonTagRepository() {
  if (!instance) {
    instance = new JsonTagRepository();
  }
  return instance;
}

export function resetJsonTagRepository() {
  instance = null;
}

export default JsonTagRepository;
