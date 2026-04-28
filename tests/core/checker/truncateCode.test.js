/**
 * CodeChecker.truncateCode
 *
 * [Fix C2] preserveOriginalLineNumbers 옵션 회귀 방지.
 * truncate 결과가 원본 라인 번호 prefix를 정확히 가지는지 확인한다.
 */

import { describe, it, expect } from 'vitest';
import { CodeChecker } from '../../../src/core/checker/codeChecker.js';

describe('CodeChecker.truncateCode', () => {
  const checker = new CodeChecker();

  it('짧은 코드는 그대로 반환 (옵션 끔)', () => {
    const code = 'a\nb\nc';
    expect(checker.truncateCode(code, 100, [])).toBe(code);
  });

  it('짧은 코드에 원본 라인 번호 prefix 부여', () => {
    const code = 'foo\nbar\nbaz';
    const result = checker.truncateCode(code, 1000, [], {
      preserveOriginalLineNumbers: true
    });
    expect(result).toContain('   1: foo');
    expect(result).toContain('   2: bar');
    expect(result).toContain('   3: baz');
  });

  it('빈 코드는 빈 문자열 또는 falsy를 그대로', () => {
    expect(checker.truncateCode('', 100, [])).toBe('');
    expect(checker.truncateCode(null, 100, [])).toBeNull();
  });

  it('긴 코드 + 보존 라인 + 라인번호 옵션: 보존 라인이 결과에 원본 번호와 함께 남음', () => {
    // 100줄 생성, 각 줄 60자
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1} ${'x'.repeat(50)}`);
    const code = lines.join('\n');

    // 50번째 라인을 보존 대상으로
    const result = checker.truncateCode(code, 1000, [50], {
      preserveOriginalLineNumbers: true
    });

    // 보존된 50번 라인이 "  50: " prefix와 함께 결과에 있어야 함
    expect(result).toMatch(/\b50: line50/);
    // 멀리 떨어진 라인(예: 1번, 100번)은 잘려나가서 없을 수 있음
    // 핵심: 50번 라인의 prefix가 1이 아닌 50으로 표시되는 것
  });

  it('보존 라인 없을 때 폴백(앞뒤 절반)도 라인 번호 유지', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `L${i + 1} ${'y'.repeat(30)}`);
    const code = lines.join('\n');

    const result = checker.truncateCode(code, 500, [], {
      preserveOriginalLineNumbers: true
    });

    // 앞부분과 뒷부분이 모두 prefix 가지고 들어가야 함
    expect(result).toMatch(/\s+1: L1/);
    expect(result).toMatch(/\s+50: L50/);
    expect(result).toContain('// ...');
  });

  it('생략 주석 자리는 prefix 없이 들어감 (LLM이 무시)', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `code${i + 1} ${'z'.repeat(40)}`);
    const code = lines.join('\n');

    // 양 끝 라인을 보존 → 가운데가 잘리며 "// ... (N줄 생략) ..." 삽입
    const result = checker.truncateCode(code, 200, [10, 190], {
      preserveOriginalLineNumbers: true
    });

    // 생략 주석은 "// ..." 로 시작 (라인 번호 prefix 없음)
    const ellipsisLines = result.split('\n').filter(l => /^\s*\/\/\s*\.\.\./.test(l));
    expect(ellipsisLines.length).toBeGreaterThan(0);
    // 보존 라인은 prefix 가짐
    expect(result).toMatch(/\b10: code10/);
    expect(result).toMatch(/\b190: code190/);
  });
});
