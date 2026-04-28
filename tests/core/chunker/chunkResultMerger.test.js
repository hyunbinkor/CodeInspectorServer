/**
 * ChunkResultMerger.convertLineNumbers
 *
 * 청킹 모드의 라인 번호 변환 정확성. 회귀 시 모든 청킹 검사 결과의
 * 라인 표시가 어긋나므로 회귀 영향이 매우 큼.
 */

import { describe, it, expect } from 'vitest';
import { ChunkResultMerger } from '../../../src/core/chunker/chunkResultMerger.js';

describe('ChunkResultMerger.convertLineNumbers', () => {
  const merger = new ChunkResultMerger();

  it('메서드 코드 기준 라인을 원본 파일 기준으로 변환', () => {
    const chunk = { lineRange: { start: 100, end: 130 }, methodName: 'doX' };
    const issues = [{ ruleId: 'R1', line: 3 }];

    const result = merger.convertLineNumbers(issues, chunk);
    expect(result[0].line).toBe(102);   // 100 + 3 - 1
  });

  it('라인이 없는 이슈는 메서드 시작 라인으로 대체', () => {
    const chunk = { lineRange: { start: 50, end: 80 } };
    const issues = [{ ruleId: 'R2' /* line 없음 */ }];

    const result = merger.convertLineNumbers(issues, chunk);
    expect(result[0].line).toBe(50);
  });

  it('범위 초과 라인은 메서드 끝으로 클램핑', () => {
    const chunk = { lineRange: { start: 100, end: 110 }, methodName: 'm' };
    const issues = [{ ruleId: 'R3', line: 999 }];

    const result = merger.convertLineNumbers(issues, chunk);
    expect(result[0].line).toBe(110);
  });

  it('범위 미만 라인은 메서드 시작으로 클램핑', () => {
    // 가능성은 낮지만 LLM이 음수/0을 리포트해도 안전해야 함
    const chunk = { lineRange: { start: 50, end: 80 } };
    const issues = [{ ruleId: 'R4', line: -5 }];

    const result = merger.convertLineNumbers(issues, chunk);
    expect(result[0].line).toBeGreaterThanOrEqual(50);
  });

  it('chunk.lineRange가 없으면 기본값(1)을 사용', () => {
    const chunk = {};
    const issues = [{ ruleId: 'R5', line: 5 }];

    const result = merger.convertLineNumbers(issues, chunk);
    expect(result[0].line).toBe(1);   // rangeStart=1, rangeEnd=1 → 클램핑됨
  });

  it('이슈 객체의 다른 필드를 보존', () => {
    const chunk = { lineRange: { start: 10, end: 20 } };
    const issues = [{
      ruleId: 'R6',
      line: 5,
      severity: 'HIGH',
      description: 'foo'
    }];

    const result = merger.convertLineNumbers(issues, chunk);
    expect(result[0]).toMatchObject({
      ruleId: 'R6',
      severity: 'HIGH',
      description: 'foo'
    });
  });
});
