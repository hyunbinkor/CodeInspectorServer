/**
 * 데이터 동기화 서비스
 * 
 * Pull/Diff/Push 방식의 데이터 동기화
 * - Pull: 전체 규칙/태그 다운로드
 * - Diff: 변경사항 미리보기
 * - Push: 전체 데이터 업로드 (자동 백업)
 * 
 * @module services/dataService
 */

import fs from 'fs/promises';
import path from 'path';
import { getQdrantRuleRepository } from '../repositories/impl/QdrantRuleRepository.js';
import { getJsonTagRepository } from '../repositories/impl/JsonTagRepository.js';
import { config } from '../config/index.js';
import logger from '../utils/loggerUtils.js';

export class DataService {
  constructor() {
    this.ruleRepository = null;
    this.tagRepository = null;
    this.initialized = false;
  }

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    logger.info('🔧 DataService 초기화 중...');

    this.ruleRepository = getQdrantRuleRepository();
    await this.ruleRepository.initialize();

    this.tagRepository = getJsonTagRepository();
    await this.tagRepository.initialize();

    this.initialized = true;
    logger.info('✅ DataService 초기화 완료');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pull - 전체 데이터 다운로드
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 전체 데이터 Pull
   * 
   * @returns {Promise<Object>} { version, rules, tags, metadata }
   */
  async pull() {
    await this.ensureInitialized();

    logger.info('[DataService] Pull 시작...');

    // 규칙 조회
    const rules = await this.ruleRepository.findAll();
    
    // 태그 정의 조회
    const tagData = await this.tagRepository.getAllData();

    // 버전 생성 (타임스탬프 기반)
    const version = Date.now();

    const result = {
      version,
      pulledAt: new Date().toISOString(),
      rules: {
        count: rules.length,
        items: rules
      },
      tags: tagData,
      metadata: {
        ruleCount: rules.length,
        tagCount: Object.keys(tagData.tags || {}).length,
        compoundTagCount: Object.keys(tagData.compoundTags || {}).length
      }
    };

    logger.info(`[DataService] Pull 완료: 규칙 ${rules.length}개, 태그 ${Object.keys(tagData.tags || {}).length}개`);

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Diff - 변경사항 미리보기
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 변경사항 비교 (Diff)
   * 
   * @param {Object} localData - 로컬 데이터 { baseVersion, rules, tags }
   * @returns {Promise<Object>} 변경사항 상세
   */
  async diff(localData) {
    await this.ensureInitialized();

    logger.info('[DataService] Diff 시작...');

    const { baseVersion, rules: localRules = [], tags: localTags = {} } = localData;

    // 현재 서버 데이터 조회
    const serverRules = await this.ruleRepository.findAll();
    const serverTagData = await this.tagRepository.getAllData();

    // 규칙 변경사항 계산
    const ruleChanges = this.calculateRuleChanges(localRules, serverRules);

    // 태그 변경사항 계산
    const tagChanges = this.calculateTagChanges(
      localTags.tags || {},
      serverTagData.tags || {}
    );

    // 버전 충돌 확인
    const currentVersion = await this.getCurrentVersion();
    const hasConflict = baseVersion && baseVersion < currentVersion;

    const result = {
      baseVersion,
      currentVersion,
      hasConflict,
      rules: {
        added: ruleChanges.added,
        modified: ruleChanges.modified,
        deleted: ruleChanges.deleted,
        unchanged: ruleChanges.unchanged,
        summary: {
          addedCount: ruleChanges.added.length,
          modifiedCount: ruleChanges.modified.length,
          deletedCount: ruleChanges.deleted.length,
          unchangedCount: ruleChanges.unchanged.length
        }
      },
      tags: {
        added: tagChanges.added,
        modified: tagChanges.modified,
        deleted: tagChanges.deleted,
        unchanged: tagChanges.unchanged,
        summary: {
          addedCount: tagChanges.added.length,
          modifiedCount: tagChanges.modified.length,
          deletedCount: tagChanges.deleted.length,
          unchangedCount: tagChanges.unchanged.length
        }
      }
    };

    logger.info(`[DataService] Diff 완료: 규칙(+${ruleChanges.added.length}/-${ruleChanges.deleted.length}/~${ruleChanges.modified.length}), 태그(+${tagChanges.added.length}/-${tagChanges.deleted.length}/~${tagChanges.modified.length})`);

    return result;
  }

  /**
   * 규칙 변경사항 계산
   * @private
   */
  calculateRuleChanges(localRules, serverRules) {
    const localMap = new Map(localRules.map(r => [r.ruleId, r]));
    const serverMap = new Map(serverRules.map(r => [r.ruleId, r]));

    const added = [];
    const modified = [];
    const deleted = [];
    const unchanged = [];

    // 로컬에 있는 것 체크
    for (const [ruleId, localRule] of localMap) {
      const serverRule = serverMap.get(ruleId);
      
      if (!serverRule) {
        // 서버에 없음 → 추가됨
        added.push({ ruleId, rule: localRule });
      } else if (this.isRuleModified(localRule, serverRule)) {
        // 서버에 있지만 다름 → 수정됨
        modified.push({ 
          ruleId, 
          local: localRule, 
          server: serverRule,
          changes: this.getRuleChanges(localRule, serverRule)
        });
      } else {
        unchanged.push(ruleId);
      }
    }

    // 서버에만 있는 것 → 삭제됨
    for (const [ruleId, serverRule] of serverMap) {
      if (!localMap.has(ruleId)) {
        deleted.push({ ruleId, rule: serverRule });
      }
    }

    return { added, modified, deleted, unchanged };
  }

  /**
   * 규칙 수정 여부 확인
   * @private
   */
  isRuleModified(local, server) {
    // 핵심 필드만 비교
    const compareFields = ['title', 'description', 'category', 'severity', 
                          'checkType', 'tagCondition', 'message', 'suggestion', 'isActive'];
    
    for (const field of compareFields) {
      if (JSON.stringify(local[field]) !== JSON.stringify(server[field])) {
        return true;
      }
    }
    return false;
  }

  /**
   * 규칙 변경 상세 조회
   * @private
   */
  getRuleChanges(local, server) {
    const changes = [];
    const compareFields = ['title', 'description', 'category', 'severity', 
                          'checkType', 'tagCondition', 'message', 'suggestion', 'isActive'];
    
    for (const field of compareFields) {
      if (JSON.stringify(local[field]) !== JSON.stringify(server[field])) {
        changes.push({
          field,
          local: local[field],
          server: server[field]
        });
      }
    }
    return changes;
  }

  /**
   * 태그 변경사항 계산
   * @private
   */
  calculateTagChanges(localTags, serverTags) {
    const added = [];
    const modified = [];
    const deleted = [];
    const unchanged = [];

    // 로컬에 있는 것 체크
    for (const [tagName, localTag] of Object.entries(localTags)) {
      const serverTag = serverTags[tagName];
      
      if (!serverTag) {
        added.push({ name: tagName, tag: localTag });
      } else if (JSON.stringify(localTag) !== JSON.stringify(serverTag)) {
        modified.push({ name: tagName, local: localTag, server: serverTag });
      } else {
        unchanged.push(tagName);
      }
    }

    // 서버에만 있는 것
    for (const [tagName, serverTag] of Object.entries(serverTags)) {
      if (!(tagName in localTags)) {
        deleted.push({ name: tagName, tag: serverTag });
      }
    }

    return { added, modified, deleted, unchanged };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Push - 전체 데이터 업로드
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 전체 데이터 Push
   * 
   * @param {Object} data - 업로드할 데이터 { baseVersion, rules, tags, force }
   * @returns {Promise<Object>} 결과
   */
  async push(data) {
    await this.ensureInitialized();

    const { baseVersion, rules = [], tags = {}, force = false } = data;

    logger.info(`[DataService] Push 시작: 규칙 ${rules.length}개, 태그 ${Object.keys(tags.tags || {}).length}개`);

    // 버전 충돌 확인 (force가 아닌 경우)
    if (!force && baseVersion) {
      const currentVersion = await this.getCurrentVersion();
      if (baseVersion < currentVersion) {
        return {
          success: false,
          error: 'VERSION_CONFLICT',
          message: '서버 데이터가 변경되었습니다. Pull 후 다시 시도하거나 force 옵션을 사용하세요.',
          baseVersion,
          currentVersion
        };
      }
    }

    // 자동 백업
    let backupPath = null;
    if (config.sync.autoBackup) {
      backupPath = await this.createBackup();
    }

    try {
      // 규칙 교체
      await this.ruleRepository.deleteAll();
      const ruleResult = await this.ruleRepository.saveAll(rules);

      // 태그 교체
      if (tags && Object.keys(tags).length > 0) {
        await this.tagRepository.replaceAllData(tags);
      }

      // 새 버전 생성
      const newVersion = Date.now();

      logger.info(`[DataService] Push 완료: 규칙 ${ruleResult.success}/${rules.length}, 버전 ${newVersion}`);

      return {
        success: true,
        newVersion,
        pushedAt: new Date().toISOString(),
        backupPath,
        rules: {
          total: rules.length,
          success: ruleResult.success,
          failed: ruleResult.failed
        },
        tags: {
          total: Object.keys(tags.tags || {}).length
        }
      };

    } catch (error) {
      logger.error(`[DataService] Push 실패: ${error.message}`);
      
      // 백업에서 복구 시도
      if (backupPath) {
        logger.info('[DataService] 백업에서 복구 시도...');
        // TODO: 복구 로직
      }

      throw error;
    }
  }

  /**
   * 백업 생성
   * @private
   */
  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = config.paths.backup;
    const backupPath = path.join(backupDir, `backup_${timestamp}.json`);

    // 백업 디렉토리 확인
    await fs.mkdir(backupDir, { recursive: true });

    // 현재 데이터 조회
    const rules = await this.ruleRepository.findAll();
    const tags = await this.tagRepository.getAllData();

    // 백업 파일 생성
    const backupData = {
      backupAt: new Date().toISOString(),
      version: Date.now(),
      rules,
      tags
    };

    await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');
    logger.info(`[DataService] 백업 생성: ${backupPath}`);

    // 오래된 백업 정리
    await this.cleanupOldBackups();

    return backupPath;
  }

  /**
   * 오래된 백업 정리
   * @private
   */
  async cleanupOldBackups() {
    const backupDir = config.paths.backup;
    const maxBackups = config.sync.maxBackups || 10;

    try {
      const files = await fs.readdir(backupDir);
      const backupFiles = files
        .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
        .sort()
        .reverse();

      // maxBackups 초과분 삭제
      for (let i = maxBackups; i < backupFiles.length; i++) {
        const filePath = path.join(backupDir, backupFiles[i]);
        await fs.unlink(filePath);
        logger.debug(`[DataService] 오래된 백업 삭제: ${backupFiles[i]}`);
      }
    } catch (error) {
      logger.warn(`[DataService] 백업 정리 실패: ${error.message}`);
    }
  }

  /**
   * 현재 버전 조회
   * @private
   */
  async getCurrentVersion() {
    // 규칙 개수와 현재 시간 기반 버전
    const count = await this.ruleRepository.count();
    // 실제 구현에서는 별도 메타데이터 테이블에서 조회
    return Date.now();
  }

  /**
   * 통계 조회
   */
  async getStats() {
    await this.ensureInitialized();

    const ruleStats = await this.ruleRepository.getStats();
    const tagData = await this.tagRepository.getAllData();

    return {
      rules: {
        count: ruleStats?.pointsCount || 0,
        status: ruleStats?.status
      },
      tags: {
        count: Object.keys(tagData.tags || {}).length,
        compoundCount: Object.keys(tagData.compoundTags || {}).length,
        categories: Object.keys(tagData.tagCategories || {})
      }
    };
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

export function getDataService() {
  if (!instance) {
    instance = new DataService();
  }
  return instance;
}

export function resetDataService() {
  instance = null;
}

export default DataService;
