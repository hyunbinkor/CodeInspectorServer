/**
 * codeUtils — 라인 번호, 코드 추출, 정제
 */

import { describe, it, expect } from 'vitest';
import {
  addLineNumbers,
  extractClassName,
  extractPackageName,
  extractMethodNames,
  validateJavaSyntax,
  removeCommentsAndStrings
} from '../../src/utils/codeUtils.js';

describe('addLineNumbers', () => {
  it('각 줄 앞에 1-based 번호를 붙인다', () => {
    const result = addLineNumbers('line1\nline2\nline3');
    expect(result).toContain('   1: line1');
    expect(result).toContain('   2: line2');
    expect(result).toContain('   3: line3');
  });

  it('startLine 인자로 시작 번호를 바꿀 수 있다', () => {
    const result = addLineNumbers('a\nb', 100);
    expect(result).toMatch(/^ *100: a/);
    expect(result).toContain('101: b');
  });

  it('빈 입력은 빈 문자열', () => {
    expect(addLineNumbers('')).toBe('');
    expect(addLineNumbers(null)).toBe('');
  });

  it('단일 줄도 처리된다', () => {
    expect(addLineNumbers('one')).toBe('   1: one');
  });
});

describe('extractClassName', () => {
  it('클래스 선언에서 이름을 추출', () => {
    expect(extractClassName('public class Foo {}')).toBe('Foo');
    expect(extractClassName('class Bar extends Baz {}')).toBe('Bar');
  });

  it('클래스 없으면 Unknown', () => {
    expect(extractClassName('int x = 1;')).toBe('Unknown');
    expect(extractClassName('')).toBe('Unknown');
  });
});

describe('extractPackageName', () => {
  it('패키지 선언을 추출', () => {
    expect(extractPackageName('package com.example.foo;')).toBe('com.example.foo');
  });

  it('패키지 없으면 null', () => {
    expect(extractPackageName('class X {}')).toBeNull();
  });
});

describe('extractMethodNames', () => {
  it('메서드 시그니처에서 이름을 추출', () => {
    const code = `
      public void doStuff() {}
      private int compute(int x) { return x; }
      protected String getName() { return null; }
    `;
    const names = extractMethodNames(code);
    expect(names).toContain('doStuff');
    expect(names).toContain('compute');
    expect(names).toContain('getName');
  });

  it('메서드 없으면 빈 배열', () => {
    expect(extractMethodNames('class X {}')).toEqual([]);
  });
});

describe('validateJavaSyntax', () => {
  it('가장 단순한 유효 코드는 true', () => {
    const code = 'public class Foo { void bar() {} }';
    expect(validateJavaSyntax(code)).toBe(true);
  });

  it('너무 짧은 코드는 false', () => {
    expect(validateJavaSyntax('x')).toBe(false);
    expect(validateJavaSyntax('')).toBe(false);
  });

  it('중괄호 불균형(>2)은 false', () => {
    // 열린 { 5개, 닫힌 } 1개 → 차이 4 > 허용치 2
    expect(validateJavaSyntax('public class { { { { { }')).toBe(false);
  });
});

describe('removeCommentsAndStrings', () => {
  it('블록 주석을 제거한다', () => {
    const code = 'a /* comment */ b';
    expect(removeCommentsAndStrings(code)).toBe('a  b');
  });

  it('라인 주석을 제거한다', () => {
    const code = 'int x; // explanation';
    expect(removeCommentsAndStrings(code)).toBe('int x; ');
  });

  it('문자열 리터럴을 빈 따옴표로 치환한다', () => {
    const code = 'String s = "hello world";';
    expect(removeCommentsAndStrings(code)).toBe('String s = "";');
  });

  it('빈 입력은 빈 문자열', () => {
    expect(removeCommentsAndStrings('')).toBe('');
    expect(removeCommentsAndStrings(null)).toBe('');
  });
});
