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
 * ─── 버그 수정 ─────────────────────────────────────────────────────────────
 * [Fix 1] getCurrentVersion()이 항상 Date.now()를 반환하여 무조건 충돌 발생
 *   → version.json 파일에 버전을 영속 저장하도록 변경
 *
 * [Fix 2] isRuleModified / getRuleChanges의 compareFields에
 *   antiPatterns, goodPatterns, problematicCode, fixedCode 등 누락
 *   → 전체 필드 추가 + RegExp 객체 정규화 처리
 *
 * [Fix D] Push 성공 후 tagDefinitionLoader / codeTagger 싱글톤 리셋
 *   → JSON 파일 갱신 후 메모리의 compiledPatterns가 갱신되지 않던 문제 해결
 *   → 다음 검사 요청 시 새 패턴으로 자동 재초기화
 *
 * [Fix #1] Push 후 ruleRepository / codeChecker 싱글톤도 리셋
 *   → 규칙 변경 시 기존 캐시된 참조가 남아 있던 문제 해결
 *
 * [Fix #5] Push 후 checkService 싱글톤 리셋
 *   → checkService가 이전 codeChecker 참조를 유지하던 문제 해결
 *
 * [Qdrant 이전] 태그 저장소를 JsonTagRepository(/tmp) → QdrantTagRepository로 교체
 *   → 서버 재시작 시에도 태그 데이터 유지
 *
 * [Fix #8] 버전 관리를 /tmp/version.json → Qdrant 태그 메타데이터로 이전
 *   → 서버 재시작 시에도 버전 정보 유지
 *
 * [Fix #7] 백업 저장을 /tmp/backup → Qdrant 포인트로 이전
 *   → 서버 재시작 시에도 백업 데이터 유지
 *
 * @module services/dataService
 */

import { getQdrantRuleRepository, resetQdrantRuleRepository } from '../repositories/impl/QdrantRuleRepository.js';  // [Fix #1]
import { getQdrantTagRepository } from '../repositories/impl/QdrantTagRepository.js';   // [Qdrant 이전] JSON → Qdrant
import { resetTagDefinitionLoader } from '../core/tagger/tagDefinitionLoader.js';  // [Fix D]
import { resetCodeTagger } from '../core/tagger/codeTagger.js';                    // [Fix D]
import { resetCodeChecker } from '../core/checker/codeChecker.js';                 // [Fix #1]
import { resetCheckService } from './checkService.js';                             // [Fix #5]
import { config } from '../config/index.js';
import logger from '../utils/loggerUtils.js';

// ─── Diff 비교 대상 필드 (공유 상수) ──────────────────────────────────────────
// [Fix 2] 기존: 9개 필드만 비교 → 패턴/코드/태그 필드 전부 누락
//         수정: 의미 있는 모든 필드를 비교
const RULE_COMPARE_FIELDS = [
  // 기본 메타
  'title', 'description', 'category', 'severity',
  'checkType', 'tagCondition', 'message', 'suggestion', 'isActive',
  // 패턴 (antiPatterns, goodPatterns는 RegExp 포함이라 별도 정규화 필요)
  'antiPatterns', 'goodPatterns',
  // 코드 예시
  'problematicCode', 'fixedCode',
  // 태그 필터
  'requiredTags', 'excludeTags', 'keywords',
  // AST 관련
  'astHints', 'checkPoints',
  // 예시
  'examples',
];

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

    this.tagRepository = getQdrantTagRepository();   // [Qdrant 이전]
    await this.tagRepository.initialize();

    this.initialized = true;
    logger.info('✅ DataService 초기화 완료');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [Fix #8] 버전 관리 — /tmp/version.json 대신 Qdrant 메타데이터 사용
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 저장된 버전 읽기
   * @private
   * @returns {Promise<number>}
   */
  async loadVersion() {
    try {
      return await this.tagRepository.getVersion();
    } catch (error) {
      logger.warn(`[DataService] 버전 조회 실패: ${error.message}`);
      return 0;
    }
  }

  /**
   * 버전 저장
   * @private
   * @param {number} version
   */
  async saveVersion(version) {
    try {
      await this.tagRepository.setVersion(version);
      logger.debug(`[DataService] 버전 저장: ${version}`);
    } catch (error) {
      logger.warn(`[DataService] 버전 저장 실패: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pull
  // ═══════════════════════════════════════════════════════════════════════════

  async pull() {
    await this.ensureInitialized();

    logger.info('[DataService] Pull 시작...');

    const rules   = await this.ruleRepository.findAll();
    const tagData = await this.tagRepository.getAllData();

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
  // Diff
  // ═══════════════════════════════════════════════════════════════════════════

  async diff(localData) {
    await this.ensureInitialized();

    logger.info('[DataService] Diff 시작...');

    const { baseVersion, rules: localRules = [], tags: localTags = {} } = localData;

    const serverRules   = await this.ruleRepository.findAll();
    const serverTagData = await this.tagRepository.getAllData();

    const ruleChanges = this.calculateRuleChanges(localRules, serverRules);
    const tagChanges  = this.calculateTagChanges(
      localTags.tags     || {},
      serverTagData.tags || {},
    );

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

    for (const [ruleId, serverRule] of serverMap) {
      if (!localMap.has(ruleId)) {
        deleted.push({ ruleId, rule: serverRule });
      }
    }

    return { added, modified, deleted, unchanged };
  }

  /**
   * 규칙 수정 여부 확인
   * 
   * [Fix 2] compareFields 확장 + RegExp 정규화
   * @private
   */
  isRuleModified(local, server) {
    for (const field of RULE_COMPARE_FIELDS) {
      const localVal  = this._normalizeFieldForComparison(field, local[field]);
      const serverVal = this._normalizeFieldForComparison(field, server[field]);

      if (JSON.stringify(localVal) !== JSON.stringify(serverVal)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 규칙 변경 상세 조회
   * 
   * [Fix 2] compareFields 확장 + RegExp 정규화
   * @private
   */
  getRuleChanges(local, server) {
    const changes = [];

    for (const field of RULE_COMPARE_FIELDS) {
      const localVal  = this._normalizeFieldForComparison(field, local[field]);
      const serverVal = this._normalizeFieldForComparison(field, server[field]);

      if (JSON.stringify(localVal) !== JSON.stringify(serverVal)) {
        changes.push({ field, local: localVal, server: serverVal });
      }
    }
    return changes;
  }

  /**
   * Diff 비교를 위한 필드 값 정규화
   * 
   * 문제: Qdrant에서 읽은 규칙의 antiPatterns/goodPatterns에는
   * _parsePatternArray()가 변환한 RegExp 객체가 들어있음.
   * JSON.stringify(RegExp)은 "{}"를 반환하므로 비교가 깨짐.
   * 
   * 해결: 패턴 필드는 { pattern, flags, description } 형태로 통일
   * 
   * @private
   */
  _normalizeFieldForComparison(field, value) {
    if (value === undefined || value === null) return null;

    // antiPatterns, goodPatterns: RegExp 객체 → 순수 JSON으로 변환
    if (field === 'antiPatterns' || field === 'goodPatterns') {
      if (!Array.isArray(value)) return [];
      return value.map(p => {
        if (p instanceof RegExp) {
          return { pattern: p.source, flags: p.flags, description: '' };
        }
        if (p && p.regex instanceof RegExp) {
          // _parsePatternArray 결과: { regex: RegExp, description: string }
          return { pattern: p.regex.source, flags: p.regex.flags, description: p.description || '' };
        }
        if (p && typeof p === 'object' && p.pattern) {
          // 이미 순수 JSON 형태: { pattern, flags, description }
          return { pattern: p.pattern, flags: p.flags || 'g', description: p.description || '' };
        }
        if (typeof p === 'string') {
          return { pattern: p, flags: 'g', description: '' };
        }
        return p;
      });
    }

    return value;
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

    for (const [tagName, serverTag] of Object.entries(serverTags)) {
      if (!(tagName in localTags)) {
        deleted.push({ name: tagName, tag: serverTag });
      }
    }

    return { added, modified, deleted, unchanged };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Push
  // ═══════════════════════════════════════════════════════════════════════════

  async push(data) {
    await this.ensureInitialized();

    const { baseVersion, rules = [], tags = {}, force = false } = data;

    logger.info(
      `[DataService] Push 시작: 규칙 ${rules.length}개, ` +
      `태그 ${Object.keys(tags.tags || {}).length}개`,
    );

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

    // [Fix #7] 자동 백업 (Qdrant에 저장)
    let backupId = null;
    if (config.sync.autoBackup) {
      backupId = await this.createBackup();
    }

    try {
      // 규칙 전체 교체 (deleteAll → saveAll)
      // Push 직전 백업이 생성되므로 실패 시 복구 가능
      await this.ruleRepository.deleteAll();
      const ruleResult = await this.ruleRepository.saveAll(rules);

      if (tags && Object.keys(tags).length > 0) {
        await this.tagRepository.replaceAllData(tags);
      }

      const newVersion = Date.now();
      await this.saveVersion(newVersion);

      // 싱글톤 전체 리셋
      resetTagDefinitionLoader();
      resetCodeTagger();
      resetQdrantRuleRepository();
      resetCodeChecker();
      resetCheckService();
      logger.info('[DataService] 전체 싱글톤 리셋 완료 (다음 검사 시 재초기화)');

      logger.info(
        `[DataService] Push 완료: 규칙 ${ruleResult.success}/${rules.length}, 버전 ${newVersion}`,
      );

      return {
        success:    true,
        newVersion,
        pushedAt:   new Date().toISOString(),
        backupId,
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

      if (backupId) {
        logger.info(`[DataService] 백업 ID: ${backupId} (수동 복구 가능)`);
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
  /**
   * 백업 생성
   * 
   * [Fix #7] /tmp/backup → Qdrant에 저장 (재시작 내성)
   * @private
   * @returns {Promise<string>} 백업 ID
   */
  async createBackup() {
    const rules = await this.ruleRepository.findAll();
    const tags  = await this.tagRepository.getAllData();

    const backupData = {
      backupAt: new Date().toISOString(),
      version:  await this.loadVersion(),
      rules,
      tags,
    };

    const backupId = await this.tagRepository.createBackup(backupData);
    await this.tagRepository.cleanupOldBackups(config.sync.maxBackups || 10);

    return backupId;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 버전 / 통계
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @private
   */
  async getCurrentVersion() {
    return await this.loadVersion();
  }

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