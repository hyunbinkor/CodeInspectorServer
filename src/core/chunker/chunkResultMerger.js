/**
 * 청크 결과 통합 및 SARIF 출력
 *
 * 청크별로 검사된 결과를 통합하고,
 * 라인 번호를 원본 파일 기준으로 변환하며,
 * SARIF 형식으로 출력
 *
 * 변경사항:
 * - [Fix] convertLineNumbers(): LLM에 메서드 코드만 전송하도록 변경됨에 따라
 *   headerLineCount 역산 로직 제거.
 *   LLM이 메서드 코드 기준 1-based 라인을 반환하므로
 *   단순 공식: rangeStart + issue.line - 1
 *
 * @module chunker/chunkResultMerger
 */

import logger from '../../utils/loggerUtils.js';

export class ChunkResultMerger {
  constructor() {
    this.toolName = 'java-code-quality-checker';
    this.toolVersion = '4.2.0';
    this.toolUri = 'https://github.com/example/java-code-quality-checker';
  }

  /**
   * 청크별 결과를 통합
   *
   * @param {Array}  chunkResults  - 청크별 검사 결과 배열
   * @param {Object} chunkingInfo  - 청킹 정보 (chunks, metadata)
   * @param {Object} options       - 옵션
   * @returns {Object} 통합된 결과
   */
  merge(chunkResults, chunkingInfo, options = {}) {
    const allIssues = [];
    const processedChunks = [];
    let totalLlmCalls = 0;
    let totalProcessingTime = 0;

    for (const result of chunkResults) {
      if (!result) continue;

      const chunk = chunkingInfo.chunks.find(c => c.index === result.chunkIndex);
      if (!chunk) continue;

      // 라인 번호 변환 (청크 내 → 원본)
      const convertedIssues = this.convertLineNumbers(result.issues || [], chunk);

      // 컨텍스트 정보 추가
      const enrichedIssues = convertedIssues.map(issue => ({
        ...issue,
        context: {
          className:  chunk.className,
          methodName: chunk.methodName,
          chunkIndex: chunk.index,
          chunkType:  chunk.type
        }
      }));

      allIssues.push(...enrichedIssues);

      processedChunks.push({
        index:          chunk.index,
        type:           chunk.type,
        methodName:     chunk.methodName,
        lineRange:      chunk.lineRange,
        issuesFound:    enrichedIssues.length,
        processingTime: result.processingTime || 0
      });

      totalLlmCalls       += result.llmCalls       || 0;
      totalProcessingTime += result.processingTime || 0;
    }

    const uniqueIssues = this.deduplicateIssues(allIssues);
    uniqueIssues.sort((a, b) => (a.line || 0) - (b.line || 0));
    const summary = this.generateSummary(uniqueIssues, chunkingInfo);

    return {
      file: {
        name:       chunkingInfo.metadata.fileName,
        totalLines: chunkingInfo.metadata.totalLines,
        className:  chunkingInfo.className
      },
      processing: {
        chunked:         true,
        totalChunks:     chunkingInfo.metadata.totalChunks,
        processedChunks: processedChunks.length,
        totalMethods:    chunkingInfo.metadata.totalMethods,
        processingTime:  totalProcessingTime,
        llmCalls:        totalLlmCalls
      },
      issues:  uniqueIssues,
      chunks:  processedChunks,
      summary
    };
  }

  /**
   * 라인 번호 변환 (메서드 코드 기준 → 원본 파일 기준)
   *
   * LLM에 메서드 코드(chunk.code)만 전송하므로,
   * LLM이 반환하는 line은 메서드 코드 기준 1-based.
   *
   * 공식: rangeStart + issue.line - 1
   *
   * 예시 (메서드가 원본 파일 100번 줄에서 시작):
   *   LLM이 line 3 리포트 → 100 + 3 - 1 = 102
   */
  convertLineNumbers(issues, chunk) {
    const rangeStart = chunk.lineRange?.start || 1;
    const rangeEnd   = chunk.lineRange?.end   || rangeStart;

    return issues.map(issue => {
      if (!issue.line) {
        // 라인 정보 없음 → 메서드 시작 라인으로 대체
        return { ...issue, line: rangeStart };
      }

      const originalLine = rangeStart + issue.line - 1;

      // 클램핑: 메서드 범위 내로 제한 (음수 / 범위 초과 방지)
      const clampedLine = Math.max(rangeStart, Math.min(originalLine, rangeEnd));

      if (originalLine !== clampedLine) {
        logger.debug(
          `[convertLineNumbers] 라인 클램핑: ${originalLine} → ${clampedLine} ` +
          `(method: ${chunk.methodName}, range: ${rangeStart}-${rangeEnd})`
        );
      }

      return {
        ...issue,
        line: clampedLine
      };
    });
  }

  /**
   * 중복 이슈 제거
   */
  deduplicateIssues(issues) {
    const seen = new Map();
    return issues.filter(issue => {
      const key = `${issue.ruleId}-${issue.line}-${issue.description?.substring(0, 50) || ''}`;
      if (seen.has(key)) return false;
      seen.set(key, true);
      return true;
    });
  }

  /**
   * 요약 생성
   */
  generateSummary(issues, chunkingInfo) {
    const bySeverity = {};
    const byClass    = {};
    const byMethod   = {};
    const byCategory = {};

    for (const issue of issues) {
      const severity = issue.severity           || 'MEDIUM';
      const className  = issue.context?.className  || 'unknown';
      const methodName = issue.context?.methodName || 'unknown';
      const category   = issue.category            || 'general';

      bySeverity[severity] = (bySeverity[severity] || 0) + 1;
      byClass[className]   = (byClass[className]   || 0) + 1;
      byCategory[category] = (byCategory[category] || 0) + 1;

      if (methodName !== 'unknown') {
        byMethod[methodName] = (byMethod[methodName] || 0) + 1;
      }
    }

    return { totalIssues: issues.length, bySeverity, byClass, byMethod, byCategory };
  }

  // ─── SARIF 출력 ─────────────────────────────────────────────────────────────

  /**
   * SARIF 형식으로 변환
   */
  toSARIF(mergedResult, options = {}) {
    const rules   = this.extractRules(mergedResult.issues);
    const results = this.convertToSARIFResults(mergedResult.issues, mergedResult.file);

    return {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name:           this.toolName,
            version:        this.toolVersion,
            informationUri: this.toolUri,
            rules
          }
        },
        results,
        invocations: [{
          executionSuccessful: true,
          startTimeUtc: mergedResult.processing?.startTime || new Date().toISOString(),
          endTimeUtc:   new Date().toISOString(),
          properties: {
            chunked:         mergedResult.processing?.chunked      || false,
            totalChunks:     mergedResult.processing?.totalChunks  || 1,
            totalMethods:    mergedResult.processing?.totalMethods  || 0,
            processingTimeMs: mergedResult.processing?.processingTime || 0,
            llmCalls:        mergedResult.processing?.llmCalls     || 0
          }
        }],
        properties: { summary: mergedResult.summary }
      }]
    };
  }

  extractRules(issues) {
    const rulesMap = new Map();
    for (const issue of issues) {
      if (!rulesMap.has(issue.ruleId)) {
        rulesMap.set(issue.ruleId, {
          id:   issue.ruleId,
          name: this.ruleIdToName(issue.ruleId),
          shortDescription: { text: issue.title || issue.ruleId },
          fullDescription:  { text: issue.description || issue.title || issue.ruleId },
          defaultConfiguration: { level: this.severityToLevel(issue.severity) },
          properties: {
            category: issue.category || 'general',
            tags: [issue.category || 'general', issue.checkType || 'llm']
          }
        });
      }
    }
    return Array.from(rulesMap.values());
  }

  convertToSARIFResults(issues, fileInfo) {
    return issues.map((issue) => ({
      ruleId:    issue.ruleId,
      ruleIndex: this.getRuleIndex(issues, issue.ruleId),
      level:     this.severityToLevel(issue.severity),
      message:   { text: issue.description || issue.title || 'Unknown issue' },
      locations: [{
        physicalLocation: {
          artifactLocation: {
            uri:       fileInfo.name,
            uriBaseId: '%SRCROOT%'
          },
          region: {
            startLine:   issue.line      || 1,
            startColumn: issue.column    || 1,
            endLine:     issue.endLine   || issue.line || 1,
            endColumn:   issue.endColumn || 1
          }
        },
        logicalLocations: this.buildLogicalLocations(issue, fileInfo)
      }],
      properties: {
        confidence: issue.confidence || 0.8,
        suggestion: issue.suggestion || null,
        context:    issue.context    || null,
        checkType:  issue.checkType  || 'llm'
      },
      fixes: issue.suggestion
        ? [{ description: { text: issue.suggestion } }]
        : undefined
    }));
  }

  buildLogicalLocations(issue, fileInfo) {
    const locations = [];
    if (issue.context?.className) {
      locations.push({
        name:               issue.context.className,
        kind:               'type',
        fullyQualifiedName: issue.context.className
      });
    }
    if (issue.context?.methodName) {
      locations.push({
        name:               issue.context.methodName,
        kind:               'function',
        fullyQualifiedName: `${issue.context.className || fileInfo.className}.${issue.context.methodName}`
      });
    }
    return locations.length > 0 ? locations : undefined;
  }

  getRuleIndex(issues, ruleId) {
    const uniqueRuleIds = [...new Set(issues.map(i => i.ruleId))];
    return uniqueRuleIds.indexOf(ruleId);
  }

  ruleIdToName(ruleId) {
    const parts = ruleId.split('.');
    if (parts.length >= 2) return parts.join('_').replace(/[^a-zA-Z0-9_]/g, '');
    return ruleId.replace(/[^a-zA-Z0-9]/g, '');
  }

  severityToLevel(severity) {
    const mapping = { CRITICAL: 'error', HIGH: 'error', MEDIUM: 'warning', LOW: 'note', INFO: 'note' };
    return mapping[severity] || 'warning';
  }

  // ─── GitHub / Simple JSON ────────────────────────────────────────────────────

  toGitHubAnnotations(mergedResult) {
    return mergedResult.issues.map(issue => {
      const level   = this.severityToGitHubLevel(issue.severity);
      const file    = mergedResult.file.name;
      const line    = issue.line || 1;
      const col     = issue.column || 1;
      const title   = `${issue.title || issue.ruleId} (${issue.ruleId})`;
      const message = issue.description || issue.title;
      return `::${level} file=${file},line=${line},col=${col},title=${title}::${message}`;
    }).join('\n');
  }

  severityToGitHubLevel(severity) {
    const mapping = { CRITICAL: 'error', HIGH: 'error', MEDIUM: 'warning', LOW: 'notice', INFO: 'notice' };
    return mapping[severity] || 'warning';
  }

  toSimpleJSON(mergedResult) {
    return {
      fileName:       mergedResult.file.name,
      totalLines:     mergedResult.file.totalLines,
      chunked:        mergedResult.processing.chunked,
      totalChunks:    mergedResult.processing.totalChunks,
      totalMethods:   mergedResult.processing.totalMethods,
      processingTime: mergedResult.processing.processingTime,
      llmCalls:       mergedResult.processing.llmCalls,
      issues: mergedResult.issues.map(issue => ({
        ruleId:      issue.ruleId,
        title:       issue.title,
        line:        issue.line,
        severity:    issue.severity,
        description: issue.description,
        suggestion:  issue.suggestion,
        category:    issue.category,
        className:   issue.context?.className,
        methodName:  issue.context?.methodName
      })),
      summary: mergedResult.summary
    };
  }
}

let instance = null;

export function getChunkResultMerger() {
  if (!instance) instance = new ChunkResultMerger();
  return instance;
}

export default ChunkResultMerger;