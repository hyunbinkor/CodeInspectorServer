/**
 * 정규식 유틸리티
 * 
 * PCRE→JS 변환과 안전한 RegExp 생성을 공유 유틸리티로 제공
 * 사용처: codeChecker, codeTagger, qdrantClient
 * 
 * @module utils/regexUtils
 */

import logger from './loggerUtils.js';

/**
 * PCRE 정규식을 JavaScript RegExp 호환 형태로 변환
 * 
 * PCRE 전용 기능을 JS 호환 형태로 변환:
 * - (?i), (?m), (?s), (?x) 등 인라인 플래그 → JS flags로 이동
 * - (?i:...) 등 그룹 내 플래그 → (?:...)로 변환
 * - (?>...) atomic group → (?:...)
 * - 소유 수량자 ++, *+, ?+ → +, *, ?
 * - (?P<n>...) → (?<n>...) 명명 그룹
 * - (?P=name) → \k<n> 역참조
 * 
 * @param {string} pattern - PCRE 패턴 문자열
 * @param {string} flags - 기본 플래그
 * @returns {{ pattern: string, flags: string }}
 */
export function convertPCREtoJS(pattern, flags = 'g') {
  let newPattern = pattern;
  
  // Set으로 관리하여 중복 플래그 방지
  const flagSet = new Set(flags.split(''));
  
  // 1. 선두 인라인 플래그 추출 및 제거: (?imsx)
  const leadingMatch = newPattern.match(/^\(\?([imsx]+)\)/);
  if (leadingMatch) {
    const inlineFlags = leadingMatch[1];
    newPattern = newPattern.replace(/^\(\?[imsx]+\)/, '');
    
    if (inlineFlags.includes('i')) flagSet.add('i');
    if (inlineFlags.includes('m')) flagSet.add('m');
    if (inlineFlags.includes('s')) flagSet.add('s');
  }
  
  // 2. 패턴 중간의 인라인 플래그도 처리
  // (?i:...) → (?:...) + 'i' 플래그
  newPattern = newPattern.replace(/\(\?([imsx]+):/g, (match, inlineFlags) => {
    if (inlineFlags.includes('i')) flagSet.add('i');
    if (inlineFlags.includes('m')) flagSet.add('m');
    if (inlineFlags.includes('s')) flagSet.add('s');
    return '(?:';
  });
  // (?i) 중간 독립 플래그 제거
  newPattern = newPattern.replace(/\(\?[imsx]+\)/g, '');
  
  // 3. Atomic groups (?>...) → (?:...)
  newPattern = newPattern.replace(/\(\?>/g, '(?:');
  
  // 4. Possessive quantifiers ++, *+, ?+ → +, *, ?
  newPattern = newPattern.replace(/\+\+/g, '+');
  newPattern = newPattern.replace(/\*\+/g, '*');
  newPattern = newPattern.replace(/\?\+/g, '?');
  
  // 5. Named groups (?P<n>...) → (?<n>...)
  newPattern = newPattern.replace(/\(\?P</g, '(?<');
  
  // 6. Named backreference (?P=name) → \k<n>
  newPattern = newPattern.replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
  
  const newFlags = Array.from(flagSet).join('');
  
  return { pattern: newPattern, flags: newFlags };
}

/**
 * 안전한 RegExp 생성
 * 
 * {pattern, flags} 객체에서 PCRE→JS 변환 후 RegExp를 생성
 * 실패 시 null 반환 (로그 출력)
 * 
 * @param {string} pattern - 정규식 패턴 문자열
 * @param {string} [flags='g'] - 정규식 플래그
 * @param {string} [context=''] - 로그용 컨텍스트 (규칙 ID 등)
 * @returns {RegExp|null} 생성된 RegExp 또는 null
 */
export function createRegexSafe(pattern, flags = 'g', context = '') {
  if (!pattern) return null;
  
  try {
    const converted = convertPCREtoJS(pattern, flags);
    const regex = new RegExp(converted.pattern, converted.flags);
    regex.lastIndex = 0;
    return regex;
  } catch (error) {
    // 1차 실패: 패턴 정제 시도
    try {
      const sanitized = sanitizePattern(pattern);
      const regex = new RegExp(sanitized, flags);
      regex.lastIndex = 0;
      logger.warn(`정규식 정제 후 생성 성공${context ? ` [${context}]` : ''}: ${pattern} → ${sanitized}`);
      return regex;
    } catch (error2) {
      logger.warn(`정규식 생성 실패${context ? ` [${context}]` : ''}: ${pattern} — ${error.message}`);
      return null;
    }
  }
}

/**
 * 패턴 정제 (짝이 맞지 않는 괄호 등 수정)
 * 
 * @param {string} pattern - 정규식 패턴
 * @returns {string} 정제된 패턴
 */
export function sanitizePattern(pattern) {
  if (typeof pattern !== 'string') return '';
  
  let sanitized = pattern;
  
  // PCRE inline flags 제거
  sanitized = sanitized.replace(/^\(\?[imsx]+\)/, '');
  sanitized = sanitized.replace(/\(\?[imsx]+:/g, '(?:');
  sanitized = sanitized.replace(/\(\?[imsx]+\)/g, '');
  
  // 짝이 맞지 않는 괄호 정리
  let parenCount = 0;
  let inBracket = false;
  
  for (let i = 0; i < sanitized.length; i++) {
    const char = sanitized[i];
    const prevChar = i > 0 ? sanitized[i - 1] : '';
    
    if (prevChar !== '\\') {
      if (char === '[' && !inBracket) inBracket = true;
      else if (char === ']' && inBracket) inBracket = false;
      else if (char === '(' && !inBracket) parenCount++;
      else if (char === ')' && !inBracket) parenCount--;
    }
  }
  
  if (parenCount > 0) sanitized += ')'.repeat(parenCount);
  if (inBracket) sanitized += ']';
  
  return sanitized;
}

export default {
  convertPCREtoJS,
  createRegexSafe,
  sanitizePattern
};