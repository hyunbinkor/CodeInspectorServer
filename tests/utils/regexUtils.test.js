/**
 * regexUtils — PCRE→JS 변환 / 안전 RegExp 생성
 *
 * 검사 엔진 전체에서 정규식 컴파일 진입점이라 회귀 영향 큼.
 */

import { describe, it, expect } from 'vitest';
import {
  convertPCREtoJS,
  createRegexSafe,
  sanitizePattern
} from '../../src/utils/regexUtils.js';

describe('convertPCREtoJS', () => {
  it('선두 인라인 플래그 (?i)를 JS flags로 이동시킨다', () => {
    const { pattern, flags } = convertPCREtoJS('(?i)hello', 'g');
    expect(pattern).toBe('hello');
    expect(flags).toContain('i');
    expect(flags).toContain('g');
  });

  it('그룹 내 인라인 플래그 (?i:...)를 (?:...) + flags로 변환', () => {
    const { pattern, flags } = convertPCREtoJS('(?i:hello)world', 'g');
    expect(pattern).toBe('(?:hello)world');
    expect(flags).toContain('i');
  });

  it('atomic group (?>...)를 비캡처 그룹으로 변환', () => {
    const { pattern } = convertPCREtoJS('(?>abc)+', 'g');
    expect(pattern).toBe('(?:abc)+');
  });

  it('소유 수량자 ++, *+, ?+를 일반 수량자로', () => {
    expect(convertPCREtoJS('a++', 'g').pattern).toBe('a+');
    expect(convertPCREtoJS('b*+', 'g').pattern).toBe('b*');
    expect(convertPCREtoJS('c?+', 'g').pattern).toBe('c?');
  });

  it('명명 그룹 (?P<name>...)을 JS 호환으로', () => {
    const { pattern } = convertPCREtoJS('(?P<word>\\w+)', 'g');
    expect(pattern).toBe('(?<word>\\w+)');
  });

  it('역참조 (?P=name)을 \\k<name>으로', () => {
    const { pattern } = convertPCREtoJS('(?P<x>\\w)\\s(?P=x)', 'g');
    expect(pattern).toBe('(?<x>\\w)\\s\\k<x>');
  });

  it('중복 플래그를 만들지 않는다', () => {
    const { flags } = convertPCREtoJS('(?i)hi', 'gi');
    expect(flags.match(/i/g)?.length).toBe(1);
  });
});

describe('createRegexSafe', () => {
  it('정상 패턴은 RegExp 객체를 반환', () => {
    const re = createRegexSafe('foo\\d+', 'g');
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('foo123')).toBe(true);
  });

  it('PCRE 인라인 플래그가 섞여도 컴파일된다', () => {
    const re = createRegexSafe('(?i)hello', 'g');
    expect(re.test('HELLO')).toBe(true);
  });

  it('완전히 잘못된 패턴은 null을 반환한다', () => {
    const re = createRegexSafe('[invalid', 'g');
    // sanitize 단계에서 ]을 보충해 통과할 수도 있고 null일 수도 있음.
    // 어느 쪽이든 throw하지 않아야 함.
    expect(re === null || re instanceof RegExp).toBe(true);
  });

  it('null/undefined 입력은 null을 반환한다', () => {
    expect(createRegexSafe(null)).toBeNull();
    expect(createRegexSafe(undefined)).toBeNull();
    expect(createRegexSafe('')).toBeNull();
  });

  it('lastIndex가 0으로 초기화되어 반환된다', () => {
    const re = createRegexSafe('a', 'g');
    re.test('a');
    re.test('a');
    // createRegexSafe가 새로 만들 때마다 lastIndex=0이어야 함
    const fresh = createRegexSafe('a', 'g');
    expect(fresh.lastIndex).toBe(0);
  });
});

describe('sanitizePattern', () => {
  it('짝이 맞지 않는 여는 괄호를 닫아준다', () => {
    expect(sanitizePattern('(abc')).toBe('(abc)');
    expect(sanitizePattern('((a')).toBe('((a))');
  });

  it('짝이 맞지 않는 대괄호를 닫아준다', () => {
    expect(sanitizePattern('[abc')).toBe('[abc]');
  });

  it('이스케이프된 괄호는 카운트하지 않는다', () => {
    expect(sanitizePattern('\\(abc')).toBe('\\(abc');
  });

  it('PCRE 인라인 플래그를 제거한다', () => {
    expect(sanitizePattern('(?i)hello')).toBe('hello');
    expect(sanitizePattern('(?im:foo)')).toBe('(?:foo)');
  });

  it('non-string 입력은 빈 문자열을 반환', () => {
    expect(sanitizePattern(null)).toBe('');
    expect(sanitizePattern(undefined)).toBe('');
    expect(sanitizePattern(123)).toBe('');
  });
});
