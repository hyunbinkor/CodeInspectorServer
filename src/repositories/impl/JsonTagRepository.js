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
    this.readOnly = false;  // 쓰기 불가 시 true
  }

  /**
   * 초기화 - JSON 파일 로드
   */
  async initialize() {
    if (this.initialized) return;

    logger.info(`[JsonTagRepository] 초기화 시작 - filePath: ${this.filePath}`);
    logger.info(`[JsonTagRepository] 디렉토리: ${path.dirname(this.filePath)}`);

    // 디렉토리 생성 시도
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
      logger.info(`[JsonTagRepository] 디렉토리 확인/생성 완료: ${dir}`);
    } catch (mkdirErr) {
      logger.error(`[JsonTagRepository] 디렉토리 생성 실패: ${mkdirErr.code} ${mkdirErr.message}`);
    }

    // 쓰기 권한 테스트
    try {
      const testFile = path.join(dir, '.write-test-' + Date.now());
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);
      this.readOnly = false;
      logger.info(`[JsonTagRepository] 쓰기 권한: ✅ 가능`);
    } catch (writeErr) {
      this.readOnly = true;
      logger.warn(`[JsonTagRepository] 쓰기 권한: ❌ 불가 (${writeErr.code}) - 읽기 전용 모드`);
    }

    // 파일 로드 시도
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(content);
      this.initialized = true;
      logger.info(`✅ JsonTagRepository 초기화 완료: ${Object.keys(this.data.tags || {}).length}개 태그`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn(`[JsonTagRepository] 파일 없음: ${this.filePath}`);
        
        // assets 원본에서 복사 시도
        const sources = [
          '/app/assets/tags/tag-definitions.json',
          path.resolve(path.dirname(this.filePath), '../../assets/tags/tag-definitions.json'),
        ];

        let loaded = false;
        for (const source of sources) {
          try {
            const content = await fs.readFile(source, 'utf-8');
            this.data = JSON.parse(content);
            logger.info(`[JsonTagRepository] 원본에서 로드 성공: ${source}`);
            
            // 쓰기 가능하면 복사
            if (!this.readOnly) {
              try {
                await fs.writeFile(this.filePath, content, 'utf-8');
                logger.info(`[JsonTagRepository] 파일 복사 완료: ${source} → ${this.filePath}`);
              } catch (copyErr) {
                logger.warn(`[JsonTagRepository] 파일 복사 실패: ${copyErr.code}`);
              }
            }
            loaded = true;
            break;
          } catch (e) {
            logger.debug(`[JsonTagRepository] 원본 시도 실패: ${source} (${e.code})`);
          }
        }

        if (!loaded) {
          // 빈 구조 생성
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
          logger.warn('[JsonTagRepository] 태그 정의 파일 없음, 빈 구조 생성');
        }

        this.initialized = true;
      } else {
        logger.error(`[JsonTagRepository] 태그 정의 로드 실패: ${error.code} ${error.message}`);
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
    logger.info(`[JsonTagRepository] replaceAllData 시작`);
    logger.info(`[JsonTagRepository] 대상 파일: ${this.filePath}`);
    logger.info(`[JsonTagRepository] readOnly: ${this.readOnly}`);

    // 메타데이터 업데이트
    newData._metadata = {
      ...newData._metadata,
      lastUpdated: new Date().toISOString(),
      totalTags: Object.keys(newData.tags || {}).length
    };

    // 메모리 데이터는 항상 업데이트
    this.data = newData;

    // 디스크에 저장
    const dir = path.dirname(this.filePath);
    
    // 디렉토리 생성 (재확인)
    try {
      await fs.mkdir(dir, { recursive: true });
      logger.info(`[JsonTagRepository] mkdir 성공: ${dir}`);
    } catch (mkdirErr) {
      logger.error(`[JsonTagRepository] mkdir 실패: ${mkdirErr.code} ${mkdirErr.message}`);
      throw mkdirErr;
    }

    // 디렉토리 상태 확인
    try {
      const stat = await fs.stat(dir);
      const mode = '0' + (stat.mode & 0o777).toString(8);
      logger.info(`[JsonTagRepository] 디렉토리 상태: mode=${mode} uid=${stat.uid} gid=${stat.gid}`);
    } catch (statErr) {
      logger.error(`[JsonTagRepository] 디렉토리 stat 실패: ${statErr.code}`);
    }

    // 파일 쓰기
    try {
      const content = JSON.stringify(this.data, null, 2);
      logger.info(`[JsonTagRepository] writeFile 시도: ${this.filePath} (${content.length} bytes)`);
      await fs.writeFile(this.filePath, content, 'utf-8');
      logger.info(`✅ 태그 정의 저장 완료: ${this.filePath}`);
    } catch (writeErr) {
      logger.error(`[JsonTagRepository] writeFile 실패: ${writeErr.code} ${writeErr.message}`);
      logger.error(`[JsonTagRepository] 전체 에러:`, writeErr);
      
      // 메모리에는 저장되었으므로 부분 성공으로 처리
      logger.warn(`[JsonTagRepository] 디스크 저장 실패, 메모리에만 반영됨`);
      throw writeErr;
    }

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