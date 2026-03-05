/**
 * src/services/dataService.js
 *
 * 데이터 동기화 서비스
 *
 * Pull/Diff/Push 방식의 데이터 동기화
 * - Pull: 전체 규칙/태그 다운로드
 * - Diff: 변경사항 미리보기
 * - Push: 전체 데이터 업로드 (자동 백업)
 *
 * ─── 버그 수정 (2곳) ───────────────────────────────────────────────────────
 * [Fix 1] getCurrentVersion()이 항상 Date.now()를 반환하여 무조건 충돌 발생
 *   → version.json 파일에 버전을 영속 저장하도록 변경
 *   → loadVersion() / saveVersion() 메서드 추가
 *   → pull()  : 저장된 버전 반환 (최초 실행 시에만 Date.now()로 초기화)
 *   → push()  : 성공 후 saveVersion(newVersion) 호출
 *   → getCurrentVersion() : Date.now() 대신 저장된 버전 반환
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
    this.tagRepository  = null;
    this.initialized    = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 초기화
  // ═══════════════════════════════════════════════════════════════════════════

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
  // [Fix 1] 버전 파일 영속화 헬퍼
  //
  // version.json 위치: config.paths.backup 의 부모 디렉토리
  //   예) BACKUP_PATH=/tmp/backup  →  /tmp/version.json
  //
  // 이유: backup 디렉토리는 Push마다 정리될 수 있으므로 한 단계 위에 저장합니다.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * version.json 파일 경로
   * @private
   */
  get versionFilePath() {
    return path.join(path.dirname(config.paths.backup), 'version.json');
  }

  /**
   * 저장된 버전 읽기
   * 파일이 없으면 0 반환 (최초 실행 상태)
   * @private
   * @returns {Promise<number>}
   */
  async loadVersion() {
    try {
      const content = await fs.readFile(this.versionFilePath, 'utf-8');
      const parsed  = JSON.parse(content);
      return typeof parsed.version === 'number' ? parsed.version : 0;
    } catch {
      // 파일 없음(ENOENT) 또는 JSON 파싱 오류 → 초기 상태
      return 0;
    }
  }

  /**
   * 버전 파일 저장
   * @private
   * @param {number} version
   */
  async saveVersion(version) {
    try {
      const dir = path.dirname(this.versionFilePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        this.versionFilePath,
        JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2),
        'utf-8',
      );
      logger.debug(`[DataService] 버전 파일 저장: ${version}`);
    } catch (error) {
      // 저장 실패는 치명적이지 않으므로 warn 수준으로만 기록
      logger.warn(`[DataService] 버전 파일 저장 실패: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pull - 전체 데이터 다운로드
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 전체 데이터 Pull
   *
   * [Fix 1] version 생성 방식 변경
   *   - 수정 전: 항상 Date.now() → Pull 직후 Push해도 충돌 발생
   *   - 수정 후: version.json에서 읽기. 파일 없으면 Date.now()로 초기화 후 저장
   *
   * @returns {Promise<Object>} { version, pulledAt, rules, tags, metadata }
   */
  async pull() {
    await this.ensureInitialized();

    logger.info('[DataService] Pull 시작...');

    const rules   = await this.ruleRepository.findAll();
    const tagData = await this.tagRepository.getAllData();

    // [Fix 1] 저장된 버전 사용. 최초 실행이면 현재 시각으로 초기화하고 저장
    let version = await this.loadVersion();
    if (version === 0) {
      version = Date.now();
      await this.saveVersion(version);
      logger.info(`[DataService] 버전 파일 최초 초기화: ${version}`);
    }

    const result = {
      version,
      pulledAt: new Date().toISOString(),
      rules: {
        count: rules.length,
        items: rules,
      },
      tags: tagData,
      metadata: {
        ruleCount:        rules.length,
        tagCount:         Object.keys(tagData.tags         || {}).length,
        compoundTagCount: Object.keys(tagData.compoundTags || {}).length,
      },
    };

    logger.info(
      `[DataService] Pull 완료: 규칙 ${rules.length}개, ` +
      `태그 ${Object.keys(tagData.tags || {}).length}개, 버전 ${version}`,
    );

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
    const serverRules   = await this.ruleRepository.findAll();
    const serverTagData = await this.tagRepository.getAllData();

    // 규칙 / 태그 변경사항 계산
    const ruleChanges = this.calculateRuleChanges(localRules, serverRules);
    const tagChanges  = this.calculateTagChanges(
      localTags.tags     || {},
      serverTagData.tags || {},
    );

    // [Fix 1] getCurrentVersion()이 저장된 버전을 반환하므로 정확한 충돌 감지 가능
    const currentVersion = await this.getCurrentVersion();
    const hasConflict    = !!(baseVersion && baseVersion < currentVersion);

    const result = {
      baseVersion,
      currentVersion,
      hasConflict,
      rules: {
        added:     ruleChanges.added,
        modified:  ruleChanges.modified,
        deleted:   ruleChanges.deleted,
        unchanged: ruleChanges.unchanged,
        summary: {
          addedCount:     ruleChanges.added.length,
          modifiedCount:  ruleChanges.modified.length,
          deletedCount:   ruleChanges.deleted.length,
          unchangedCount: ruleChanges.unchanged.length,
        },
      },
      tags: {
        added:     tagChanges.added,
        modified:  tagChanges.modified,
        deleted:   tagChanges.deleted,
        unchanged: tagChanges.unchanged,
        summary: {
          addedCount:     tagChanges.added.length,
          modifiedCount:  tagChanges.modified.length,
          deletedCount:   tagChanges.deleted.length,
          unchangedCount: tagChanges.unchanged.length,
        },
      },
    };

    logger.info(
      `[DataService] Diff 완료: ` +
      `규칙(+${ruleChanges.added.length}/-${ruleChanges.deleted.length}/~${ruleChanges.modified.length}), ` +
      `태그(+${tagChanges.added.length}/-${tagChanges.deleted.length}/~${tagChanges.modified.length})`,
    );

    return result;
  }

  // ─── Diff 내부 헬퍼 ────────────────────────────────────────────────────────

  /**
   * 규칙 변경사항 계산
   * @private
   */
  calculateRuleChanges(localRules, serverRules) {
    const localMap  = new Map(localRules.map(r  => [r.ruleId,  r]));
    const serverMap = new Map(serverRules.map(r => [r.ruleId, r]));

    const added     = [];
    const modified  = [];
    const deleted   = [];
    const unchanged = [];

    // 로컬에 있는 것 체크
    for (const [ruleId, localRule] of localMap) {
      const serverRule = serverMap.get(ruleId);

      if (!serverRule) {
        added.push({ ruleId, rule: localRule });
      } else if (this.isRuleModified(localRule, serverRule)) {
        modified.push({
          ruleId,
          local:   localRule,
          server:  serverRule,
          changes: this.getRuleChanges(localRule, serverRule),
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
    const compareFields = [
      'title', 'description', 'category', 'severity',
      'checkType', 'tagCondition', 'message', 'suggestion', 'isActive',
    ];

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
    const compareFields = [
      'title', 'description', 'category', 'severity',
      'checkType', 'tagCondition', 'message', 'suggestion', 'isActive',
    ];

    for (const field of compareFields) {
      if (JSON.stringify(local[field]) !== JSON.stringify(server[field])) {
        changes.push({ field, local: local[field], server: server[field] });
      }
    }
    return changes;
  }

  /**
   * 태그 변경사항 계산
   * @private
   */
  calculateTagChanges(localTags, serverTags) {
    const added     = [];
    const modified  = [];
    const deleted   = [];
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

    // 서버에만 있는 것 → 삭제됨
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
   * [Fix 1] Push 성공 후 saveVersion(newVersion) 호출
   *   - 수정 전: 버전 파일 갱신 없음 → 다음 Pull에서도 구버전 반환 → 재충돌
   *   - 수정 후: 새 버전을 파일에 저장 → 이후 Pull/Diff에서 정확한 버전 사용
   *
   * @param {Object} data - { baseVersion, rules, tags, force }
   * @returns {Promise<Object>}
   */
  async push(data) {
    await this.ensureInitialized();

    const { baseVersion, rules = [], tags = {}, force = false } = data;

    logger.info(
      `[DataService] Push 시작: 규칙 ${rules.length}개, ` +
      `태그 ${Object.keys(tags.tags || {}).length}개`,
    );

    // 버전 충돌 확인 (force가 아닌 경우)
    if (!force && baseVersion) {
      const currentVersion = await this.getCurrentVersion();
      if (baseVersion < currentVersion) {
        logger.warn(
          `[DataService] 버전 충돌: baseVersion=${baseVersion}, currentVersion=${currentVersion}`,
        );
        return {
          success:        false,
          error:          'VERSION_CONFLICT',
          message:        '서버 데이터가 변경되었습니다. Pull 후 다시 시도하거나 force 옵션을 사용하세요.',
          baseVersion,
          currentVersion,
        };
      }
    }

    // 자동 백업
    let backupPath = null;
    if (config.sync.autoBackup) {
      backupPath = await this.createBackup();
    }

    try {
      // 규칙 전체 교체
      await this.ruleRepository.deleteAll();
      const ruleResult = await this.ruleRepository.saveAll(rules);

      // 태그 전체 교체
      if (tags && Object.keys(tags).length > 0) {
        await this.tagRepository.replaceAllData(tags);
      }

      // [Fix 1] 새 버전 생성 후 파일에 저장
      //   이전: const newVersion = Date.now(); (저장 없음)
      //   이후: saveVersion()으로 영속화
      const newVersion = Date.now();
      await this.saveVersion(newVersion);

      logger.info(
        `[DataService] Push 완료: 규칙 ${ruleResult.success}/${rules.length}, 버전 ${newVersion}`,
      );

      return {
        success:    true,
        newVersion,
        pushedAt:   new Date().toISOString(),
        backupPath,
        rules: {
          total:   rules.length,
          success: ruleResult.success,
          failed:  ruleResult.failed,
        },
        tags: {
          total: Object.keys(tags.tags || {}).length,
        },
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 백업
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 백업 생성
   * @private
   */
  async createBackup() {
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir  = config.paths.backup;
    const backupPath = path.join(backupDir, `backup_${timestamp}.json`);

    await fs.mkdir(backupDir, { recursive: true });

    const rules = await this.ruleRepository.findAll();
    const tags  = await this.tagRepository.getAllData();

    const backupData = {
      backupAt: new Date().toISOString(),
      version:  Date.now(),
      rules,
      tags,
    };

    await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');
    logger.info(`[DataService] 백업 생성: ${backupPath}`);

    await this.cleanupOldBackups();

    return backupPath;
  }

  /**
   * 오래된 백업 정리
   * @private
   */
  async cleanupOldBackups() {
    const backupDir  = config.paths.backup;
    const maxBackups = config.sync.maxBackups || 10;

    try {
      const files       = await fs.readdir(backupDir);
      const backupFiles = files
        .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
        .sort()
        .reverse();

      for (let i = maxBackups; i < backupFiles.length; i++) {
        const filePath = path.join(backupDir, backupFiles[i]);
        await fs.unlink(filePath);
        logger.debug(`[DataService] 오래된 백업 삭제: ${backupFiles[i]}`);
      }
    } catch (error) {
      logger.warn(`[DataService] 백업 정리 실패: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 버전 / 통계
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 현재 서버 버전 조회
   *
   * [Fix 1] Date.now() 대신 version.json에서 읽도록 변경
   *   - 수정 전: return Date.now(); → 호출할 때마다 다른 값
   *   - 수정 후: return this.loadVersion(); → 저장된 버전을 일관되게 반환
   *
   * @private
   * @returns {Promise<number>}
   */
  async getCurrentVersion() {
    return await this.loadVersion();
  }

  /**
   * 통계 조회
   */
  async getStats() {
    await this.ensureInitialized();

    const ruleStats = await this.ruleRepository.getStats();
    const tagData   = await this.tagRepository.getAllData();

    return {
      rules: {
        count:  ruleStats?.pointsCount || 0,
        status: ruleStats?.status,
      },
      tags: {
        count:         Object.keys(tagData.tags         || {}).length,
        compoundCount: Object.keys(tagData.compoundTags || {}).length,
        categories:    Object.keys(tagData.tagCategories || {}),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 내부 유틸
  // ═══════════════════════════════════════════════════════════════════════════

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