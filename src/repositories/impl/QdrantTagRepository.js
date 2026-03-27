/**
 * Qdrant Tag Repository 구현체
 * 
 * 태그 정의를 Qdrant 벡터 DB에 저장/조회
 * 기존 JsonTagRepository의 /tmp 파일 기반 → Qdrant 영속 저장으로 교체
 * 
 * 저장 전략:
 * - 별도 컬렉션 ('tag-definitions')에 전체 태그 데이터를 단일 포인트로 저장
 * - Pull/Push 패턴에 맞춰 전체를 한 번에 읽고/쓰는 방식
 * - payload.data에 tag-definitions.json과 동일한 구조 저장
 * 
 * 초기화:
 * - 컬렉션이 없으면 생성 + /app/assets/tags/tag-definitions.json에서 초기 적재
 * - 컬렉션은 있지만 데이터가 없으면 동일하게 초기 적재
 * 
 * @module repositories/impl/QdrantTagRepository
 */

import { QdrantClient as Qdrant } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { ITagRepository } from '../ITagRepository.js';
import { config } from '../../config/index.js';
import logger from '../../utils/loggerUtils.js';

// 태그 데이터 포인트의 고정 ID (단일 포인트 전략)
const TAG_DATA_POINT_ID = '00000000-0000-0000-0000-000000000001';

export class QdrantTagRepository extends ITagRepository {
  constructor() {
    super();
    this.client = null;
    this.collectionName = config.qdrant.tagCollectionName || 'tag-definitions';
    this.vectorDimensions = config.qdrant.vectorDimensions || 1536;
    this.data = null;  // 메모리 캐시
    this.initialized = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 초기화
  // ═══════════════════════════════════════════════════════════════════════════

  async initialize() {
    if (this.initialized) return;

    logger.info(`🔧 QdrantTagRepository 초기화 중... (컬렉션: ${this.collectionName})`);

    // Qdrant 클라이언트 생성 (rule용 클라이언트와 별도)
    this.client = this._createClient();

    // 컬렉션 확인 및 생성
    const exists = await this._collectionExists();

    if (!exists) {
      logger.info(`🔨 ${this.collectionName} 컬렉션 생성 중...`);
      await this._createCollection();
      
      // 초기 데이터 적재 (JSON 파일에서)
      await this._seedFromJsonFile();
    } else {
      // 컬렉션 존재 — 데이터 있는지 확인
      const data = await this._loadFromQdrant();
      if (!data) {
        logger.info(`⚠️ ${this.collectionName} 컬렉션 비어있음, 초기 데이터 적재...`);
        await this._seedFromJsonFile();
      } else {
        this.data = data;
        logger.info(`✅ QdrantTagRepository: 태그 ${Object.keys(data.tags || {}).length}개 로드 완료`);
      }
    }

    this.initialized = true;
  }

  /**
   * Qdrant 클라이언트 생성
   * @private
   */
  _createClient() {
    const cfg = config.qdrant;
    let host = cfg.host;
    let port = cfg.port;
    let https = cfg.https || false;

    if (!host && cfg.url) {
      try {
        const parsedUrl = new URL(cfg.url);
        host = parsedUrl.hostname;
        port = parseInt(parsedUrl.port) || 443;
        https = parsedUrl.protocol === 'https:';
      } catch (e) {
        host = 'localhost';
        port = 443;
      }
    }

    const clientOptions = {
      host: host || 'localhost',
      port: port || 443,
      https,
      checkCompatibility: false
    };

    if (cfg.apiKey) {
      clientOptions.apiKey = cfg.apiKey;
    }

    return new Qdrant(clientOptions);
  }

  /**
   * 컬렉션 존재 확인
   * @private
   */
  async _collectionExists() {
    try {
      const collections = await this.client.getCollections();
      return collections.collections.some(c => c.name === this.collectionName);
    } catch (error) {
      logger.error(`컬렉션 확인 실패: ${error.message}`);
      return false;
    }
  }

  /**
   * 컬렉션 생성
   * @private
   */
  async _createCollection() {
    try {
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: this.vectorDimensions,
          distance: 'Cosine'
        }
      });

      // [Fix #7] type 필드 인덱스 (백업 필터링용)
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'type',
          field_schema: 'keyword'
        });
      } catch (e) {
        logger.debug(`인덱스 생성 경고 (type): ${e.message}`);
      }

      logger.info(`✅ ${this.collectionName} 컬렉션 생성 완료`);
    } catch (error) {
      logger.error(`컬렉션 생성 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * JSON 파일에서 초기 데이터 적재
   * @private
   */
  async _seedFromJsonFile() {
    // 원본 JSON 파일 경로 후보 (우선순위 순)
    const candidates = [
      path.join(config.paths.assets.tags, 'tag-definitions.json'),
      '/app/assets/tags/tag-definitions.json',
      path.join(process.cwd(), 'assets/tags/tag-definitions.json')
    ];

    let jsonData = null;

    for (const filePath of candidates) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        jsonData = JSON.parse(content);
        logger.info(`📥 초기 태그 데이터 로드: ${filePath}`);
        break;
      } catch (e) {
        logger.debug(`태그 파일 시도 실패: ${filePath} (${e.code || e.message})`);
      }
    }

    if (!jsonData) {
      logger.warn('⚠️ 태그 초기 데이터 파일을 찾을 수 없음, 빈 구조로 시작');
      jsonData = this._getEmptyStructure();
    }

    // Qdrant에 저장
    await this._saveToQdrant(jsonData);
    this.data = jsonData;
    
    logger.info(`✅ 초기 태그 데이터 적재 완료: 태그 ${Object.keys(jsonData.tags || {}).length}개`);
  }

  /**
   * 빈 태그 구조
   * @private
   */
  _getEmptyStructure() {
    return {
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Qdrant 읽기/쓰기
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Qdrant에서 태그 데이터 로드
   * @private
   * @returns {Object|null} 태그 데이터 또는 null (비어있을 때)
   */
  async _loadFromQdrant() {
    try {
      // [Fix #7] 백업 포인트 제외 — type='tag-definitions'만 조회
      const result = await this.client.scroll(this.collectionName, {
        filter: {
          must: [{ key: 'type', match: { value: 'tag-definitions' } }]
        },
        limit: 1,
        with_payload: true,
        with_vector: false
      });

      if (result.points.length === 0) {
        return null;
      }

      const payload = result.points[0].payload;

      // payload.data에 JSON 문자열로 저장되어 있음
      if (payload.data) {
        return typeof payload.data === 'string' 
          ? JSON.parse(payload.data) 
          : payload.data;
      }

      return null;
    } catch (error) {
      logger.error(`Qdrant 태그 데이터 로드 실패: ${error.message}`);
      return null;
    }
  }

  /**
   * Qdrant에 태그 데이터 저장 (단일 포인트 교체)
   * @private
   * @param {Object} data - 태그 전체 데이터
   */
  async _saveToQdrant(data) {
    try {
      // 메타데이터 업데이트
      data._metadata = {
        ...data._metadata,
        lastUpdated: new Date().toISOString(),
        totalTags: Object.keys(data.tags || {}).length
      };

      const point = {
        id: TAG_DATA_POINT_ID,
        vector: new Array(this.vectorDimensions).fill(0),  // 더미 벡터
        payload: {
          type: 'tag-definitions',
          data: JSON.stringify(data),  // JSON 문자열로 저장 (payload 크기 안전)
          updatedAt: new Date().toISOString(),
          tagCount: Object.keys(data.tags || {}).length,
          compoundTagCount: Object.keys(data.compoundTags || {}).length
        }
      };

      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [point]
      });

      logger.debug(`Qdrant 태그 데이터 저장 완료: 태그 ${point.payload.tagCount}개`);
    } catch (error) {
      logger.error(`Qdrant 태그 데이터 저장 실패: ${error.message}`);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ITagRepository 인터페이스 구현
  // ═══════════════════════════════════════════════════════════════════════════

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
   * 태그 저장 (메모리에만 — Push에서 일괄 반영)
   */
  async save(tag) {
    await this.ensureInitialized();
    
    const { name, ...rest } = tag;
    this.data.tags[name] = rest;
    return tag;
  }

  /**
   * 전체 태그 저장 (배치, 메모리에만)
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
    
    // Qdrant에서 최신 데이터 로드 (다른 인스턴스가 Push했을 수 있으므로)
    const freshData = await this._loadFromQdrant();
    if (freshData) {
      this.data = freshData;
    }

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
   * 전체 데이터 교체 (Push용) — Qdrant에 영속 저장
   */
  async replaceAllData(newData) {
    logger.info(`[QdrantTagRepository] replaceAllData 시작`);

    // 메모리 업데이트
    this.data = newData;

    // Qdrant에 저장 (영속)
    await this._saveToQdrant(newData);

    logger.info(`[QdrantTagRepository] replaceAllData 완료: 태그 ${Object.keys(newData.tags || {}).length}개`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [Fix #8] 버전 관리 — /tmp/version.json 대신 Qdrant 메타데이터 사용
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 현재 데이터 버전 조회
   * @returns {Promise<number>} 버전 타임스탬프 (없으면 0)
   */
  async getVersion() {
    await this.ensureInitialized();

    // 메모리 캐시에서 먼저 확인
    if (this.data?._metadata?.dataVersion) {
      return this.data._metadata.dataVersion;
    }

    // Qdrant에서 최신 로드
    const data = await this._loadFromQdrant();
    if (data?._metadata?.dataVersion) {
      return data._metadata.dataVersion;
    }

    return 0;
  }

  /**
   * 데이터 버전 저장
   * @param {number} version - 버전 타임스탬프
   */
  async setVersion(version) {
    await this.ensureInitialized();

    // 메모리 캐시 업데이트
    if (!this.data._metadata) {
      this.data._metadata = {};
    }
    this.data._metadata.dataVersion = version;

    // Qdrant에 저장
    await this._saveToQdrant(this.data);
    logger.debug(`[QdrantTagRepository] 버전 저장: ${version}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [Fix #7] 백업 관리 — /tmp/backup 대신 Qdrant에 저장
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 백업 생성 (Qdrant에 별도 포인트로 저장)
   * 
   * @param {Object} backupData - { rules, tags, version }
   * @returns {Promise<string>} 백업 ID
   */
  async createBackup(backupData) {
    await this.ensureInitialized();

    const backupId = uuidv4();
    const timestamp = new Date().toISOString();

    const point = {
      id: backupId,
      vector: new Array(this.vectorDimensions).fill(0),
      payload: {
        type: 'backup',
        data: JSON.stringify(backupData),
        createdAt: timestamp,
        ruleCount: backupData.rules?.length || 0,
        tagCount: Object.keys(backupData.tags?.tags || {}).length
      }
    };

    await this.client.upsert(this.collectionName, {
      wait: true,
      points: [point]
    });

    logger.info(`[QdrantTagRepository] 백업 생성: ${backupId} (규칙 ${point.payload.ruleCount}개, 태그 ${point.payload.tagCount}개)`);
    return backupId;
  }

  /**
   * 백업 목록 조회 (최신순)
   * 
   * @returns {Promise<Object[]>} 백업 메타 목록
   */
  async listBackups() {
    await this.ensureInitialized();

    try {
      const result = await this.client.scroll(this.collectionName, {
        filter: {
          must: [{ key: 'type', match: { value: 'backup' } }]
        },
        limit: 100,
        with_payload: true,
        with_vector: false
      });

      return result.points
        .map(p => ({
          id: p.id,
          createdAt: p.payload.createdAt,
          ruleCount: p.payload.ruleCount,
          tagCount: p.payload.tagCount
        }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (error) {
      logger.warn(`백업 목록 조회 실패: ${error.message}`);
      return [];
    }
  }

  /**
   * 오래된 백업 정리
   * 
   * @param {number} maxBackups - 보관할 최대 백업 수
   */
  async cleanupOldBackups(maxBackups = 10) {
    try {
      const backups = await this.listBackups();

      if (backups.length <= maxBackups) return;

      const toDelete = backups.slice(maxBackups);
      for (const backup of toDelete) {
        await this.client.delete(this.collectionName, {
          points: [backup.id]
        });
        logger.debug(`[QdrantTagRepository] 오래된 백업 삭제: ${backup.id} (${backup.createdAt})`);
      }

      logger.info(`[QdrantTagRepository] 백업 정리: ${toDelete.length}개 삭제 (${backups.length - toDelete.length}개 유지)`);
    } catch (error) {
      logger.warn(`백업 정리 실패: ${error.message}`);
    }
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

// ─── 싱글톤 ──────────────────────────────────────────────────────────────────

let instance = null;

export function getQdrantTagRepository() {
  if (!instance) {
    instance = new QdrantTagRepository();
  }
  return instance;
}

export function resetQdrantTagRepository() {
  instance = null;
}

export default QdrantTagRepository;