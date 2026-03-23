/**
 * Java 코드 메서드 단위 청킹
 *
 * 대용량 Java 파일(3000줄+)을 메서드 단위로 분할하여
 * 각각 독립적으로 검사할 수 있게 함
 *
 * 핵심 로직:
 * - braceDepth 기반 메서드 경계 감지
 * - 어노테이션/JavaDoc 보존
 * - 불완전 메서드 스킵
 * - 라인 매핑 테이블 생성
 *
 * 변경사항:
 * - [Fix] chunk(): codeWithHeader 생성 시 headerLineCount를 chunk에 저장
 *   LLM이 codeWithHeader 기준 라인을 리포트할 때 convertLineNumbers가
 *   원본 파일 라인으로 정확히 변환할 수 있도록 offset 정보 제공
 *
 * @module chunker/methodChunker
 */

import logger from '../../utils/loggerUtils.js';

export class MethodChunker {
  constructor(options = {}) {
    this.options = {
      targetSize: options.targetSize || 300,
      maxSize: options.maxSize || 500,
      minSize: options.minSize || 50,
      preserveImports: options.preserveImports !== false,
      verbose: options.verbose || false,
      warnThreshold: options.warnThreshold || 3000,
      hardLimit: options.hardLimit || 15000,
      autoChunkThreshold: options.autoChunkThreshold || 3000
    };
  }

  needsChunking(code) {
    const lineCount = code.split('\n').length;
    return lineCount > this.options.autoChunkThreshold;
  }

  chunk(code, metadata = {}) {
    const lines = code.split('\n');
    const chunks = [];

    logger.info(`[MethodChunker] 청킹 시작: ${lines.length}줄`);

    const { importBlock, codeStart } = this.extractImports(lines);
    const { classDeclarations, methodsStart, className } = this.extractClassDeclarations(lines, codeStart);

    const header = [...importBlock, ...classDeclarations].join('\n');

    if (header.trim().length > 0) {
      chunks.push({
        index: 0,
        code: header,
        lineRange: {
          start: 1,
          end: importBlock.length + classDeclarations.length
        },
        type: 'header',
        className: className,
        methodName: null,
        annotations: this.extractClassAnnotations(classDeclarations)
      });
    }

    const methods = this.extractMethods(lines, methodsStart);

    if (this.options.verbose) {
      logger.info(`[MethodChunker] ${methods.length}개 메서드 발견`);
    }

    methods.forEach((method, index) => {
      const methodCode = method.lines.join('\n');

      // ✅ [Fix] headerText를 변수로 분리 → headerLineCount 계산 가능하게
      //
      // codeWithHeader 구조:
      //   line 1 ~ headerLineCount   : import 블록 + "// Class: X" 주석 (LLM 컨텍스트용)
      //   line headerLineCount+1 ~   : 실제 메서드 코드 (여기가 lineRange.start에 대응)
      //
      // headerLineCount가 없으면 convertLineNumbers()에서 원본 라인 변환 시
      // import 줄 수만큼 오프셋이 더해져 라인이 뒤로 밀리고
      // 파일 총 라인 수를 초과하는 번호가 생성됨
      const headerText = `${importBlock.join('\n')}\n\n// Class: ${className}\n\n`;
      const headerLineCount = headerText.split('\n').length;

      chunks.push({
        index: chunks.length,
        code: methodCode,
        codeWithHeader: `${headerText}${methodCode}`,
        headerLineCount,            // ← 추가: convertLineNumbers에서 헤더 offset 제거에 사용
        lineRange: {
          start: method.startLine + 1,  // 1-based
          end: method.endLine + 1
        },
        type: 'method',
        className: className,
        methodName: method.name,
        annotations: method.annotations,
        lineCount: method.lineCount
      });
    });

    const lastMethodEnd = methods.length > 0
      ? methods[methods.length - 1].endLine
      : methodsStart;

    if (lastMethodEnd < lines.length - 1) {
      const remainingLines = lines.slice(lastMethodEnd + 1);
      const remainingCode = remainingLines.join('\n').trim();

      if (remainingCode.length > 0 && remainingCode !== '}') {
        chunks.push({
          index: chunks.length,
          code: remainingCode,
          lineRange: {
            start: lastMethodEnd + 2,
            end: lines.length
          },
          type: 'footer',
          className: className,
          methodName: null,
          annotations: []
        });
      }
    }

    logger.info(`[MethodChunker] 청킹 완료: ${chunks.length}개 청크 생성`);

    return {
      chunks,
      header: importBlock.join('\n'),
      className,
      metadata: {
        fileName: metadata.fileName || 'unknown.java',
        totalLines: lines.length,
        totalChunks: chunks.length,
        totalMethods: methods.length,
        strategy: 'method-based',
        chunkedAt: new Date().toISOString()
      }
    };
  }

  extractImports(lines) {
    const importBlock = [];
    let codeStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('package ') ||
          line.startsWith('import ') ||
          line === '' ||
          line.startsWith('//') ||
          line.startsWith('/*') ||
          line.startsWith('*') ||
          line.startsWith('*/')) {
        importBlock.push(lines[i]);
        codeStart = i + 1;
      } else if (line.length > 0) {
        break;
      }
    }

    return { importBlock, codeStart };
  }

  extractClassDeclarations(lines, startFrom) {
    const classDeclarations = [];
    let methodsStart = startFrom;
    let className = null;
    let braceCount = 0;
    let foundClass = false;

    for (let i = startFrom; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/') ||
          line.startsWith('@') || line === '') {
        classDeclarations.push(lines[i]);
        methodsStart = i + 1;
        continue;
      }

      const classMatch = line.match(/(?:public|private|protected)?\s*(?:abstract|final)?\s*class\s+(\w+)/);
      if (classMatch) {
        className = classMatch[1];
        classDeclarations.push(lines[i]);
        foundClass = true;

        if (line.includes('{')) {
          braceCount++;
          methodsStart = i + 1;
          break;
        }
        continue;
      }

      if (foundClass && line.includes('{')) {
        classDeclarations.push(lines[i]);
        methodsStart = i + 1;
        break;
      }

      if (foundClass) {
        classDeclarations.push(lines[i]);
        methodsStart = i + 1;
      }

      if (line.length > 0 && !foundClass) {
        break;
      }
    }

    return { classDeclarations, methodsStart, className };
  }

  extractClassAnnotations(classDeclarations) {
    const annotations = [];
    for (const line of classDeclarations) {
      const trimmed = line.trim();
      if (trimmed.startsWith('@')) {
        const match = trimmed.match(/@(\w+)/);
        if (match) annotations.push(match[1]);
      }
    }
    return annotations;
  }

  isMethodStart(line, lines, currentIndex) {
    const trimmed = line.trim();

    if (trimmed.startsWith('@')) {
      for (let i = currentIndex + 1; i < Math.min(currentIndex + 10, lines.length); i++) {
        const nextLine = lines[i].trim();
        if (nextLine && !nextLine.startsWith('@') && !nextLine.startsWith('/**') &&
            !nextLine.startsWith('*') && !nextLine.startsWith('*/')) {
          if (/(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>[\],\s]+\s+\w+\s*\(/.test(nextLine)) {
            return true;
          }
          break;
        }
      }
      return false;
    }

    if (trimmed.startsWith('/**')) return false;

    if (/(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>[\],\s]+\s+\w+\s*\(/.test(line)) {
      if (/[=;]\s*$/.test(trimmed) && !trimmed.includes('{')) return false;
      return true;
    }

    return false;
  }

  extractMethods(lines, startFrom) {
    const methods = [];
    let i = startFrom;

    while (i < lines.length) {
      const line = lines[i].trim();

      if (this.isMethodStart(line, lines, i)) {
        const method = this.extractSingleMethod(lines, i);
        if (method) {
          methods.push(method);
          i = method.endLine + 1;

          if (this.options.verbose) {
            logger.debug(`[MethodChunker] 메서드 추출: ${method.name} (${method.lineCount}줄)`);
          }
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return methods;
  }

  extractSingleMethod(lines, startIndex) {
    const methodLines = [];
    const annotations = [];
    let methodName = null;
    let braceDepth = 0;
    let foundMethodSignature = false;
    let currentIndex = startIndex;
    let warned = false;
    let inBlockComment = false;

    while (currentIndex < lines.length) {
      const line = lines[currentIndex].trim();

      if (line.startsWith('@')) {
        const match = line.match(/@(\w+)/);
        if (match) annotations.push(match[1]);
        methodLines.push(lines[currentIndex]);
        currentIndex++;
        continue;
      }

      if (line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/')) {
        methodLines.push(lines[currentIndex]);
        currentIndex++;
        continue;
      }

      if (line === '') {
        methodLines.push(lines[currentIndex]);
        currentIndex++;
        continue;
      }

      if (/(?:public|private|protected)\s+/.test(line)) {
        foundMethodSignature = true;
        break;
      }

      break;
    }

    if (!foundMethodSignature) return null;

    let signatureComplete = false;
    const methodStartIndex = currentIndex;

    while (currentIndex < lines.length) {
      const line = lines[currentIndex];
      const trimmedLine = line.trim();

      if (signatureComplete && braceDepth > 0 && currentIndex > methodStartIndex + 5) {
        if (this.isMethodStart(trimmedLine, lines, currentIndex)) {
          logger.warn(`[MethodChunker] 불완전 메서드 감지 (라인 ${startIndex}), 스킵`);
          return null;
        }
      }

      methodLines.push(line);

      if (!methodName) {
        const match = trimmedLine.match(/\s+(\w+)\s*\(/);
        if (match) methodName = match[1];
      }

      const braceResult = this.countBraces(line, inBlockComment);
      inBlockComment = braceResult.inBlockComment;

      if (braceResult.open > 0) signatureComplete = true;
      braceDepth += braceResult.open - braceResult.close;

      currentIndex++;

      if (signatureComplete && braceDepth === 0) {
        if (this.options.verbose && warned) {
          logger.info(`[MethodChunker] 대형 메서드 완료: ${methodName} (${currentIndex - startIndex}줄)`);
        }
        break;
      }

      if (!warned && (currentIndex - startIndex) > this.options.warnThreshold) {
        logger.warn(`[MethodChunker] 대형 메서드 감지: ${methodName || 'unknown'} (${currentIndex - startIndex}줄)`);
        warned = true;
      }

      if ((currentIndex - startIndex) > this.options.hardLimit) {
        if (braceDepth === 0 && signatureComplete) {
          logger.warn(`[MethodChunker] 초대형 메서드 완료: ${methodName}`);
          break;
        } else {
          logger.error(`[MethodChunker] 메서드 너무 큼, 불완전 (라인 ${startIndex}), 스킵`);
          return null;
        }
      }
    }

    if (signatureComplete && braceDepth !== 0) {
      logger.warn(`[MethodChunker] 메서드 불완전 (라인 ${startIndex}), braceDepth=${braceDepth}, 스킵`);
      return null;
    }

    if (!methodName || methodLines.length < 3) return null;

    return {
      name: methodName,
      annotations,
      lines: methodLines,
      startLine: startIndex,
      endLine: currentIndex - 1,
      lineCount: methodLines.length
    };
  }

  countBraces(line, inBlockComment = false) {
    let open = 0;
    let close = 0;
    let inString = false;
    let inChar = false;
    let stringChar = '';
    let i = 0;

    while (i < line.length) {
      const char = line[i];
      const nextChar = i < line.length - 1 ? line[i + 1] : '';

      if (inBlockComment) {
        if (char === '*' && nextChar === '/') { inBlockComment = false; i += 2; continue; }
        i++;
        continue;
      }

      if (!inString && !inChar && char === '/' && nextChar === '*') { inBlockComment = true; i += 2; continue; }
      if (!inString && !inChar && char === '/' && nextChar === '/') break;

      if (i > 0 && line[i - 1] === '\\' && !this.isEscapedBackslash(line, i - 1)) { i++; continue; }

      if (char === '"' && !inChar) {
        if (!inString) { inString = true; stringChar = '"'; }
        else if (stringChar === '"') { inString = false; }
        i++;
        continue;
      }

      if (char === "'" && !inString) {
        if (!inChar) inChar = true;
        else inChar = false;
        i++;
        continue;
      }

      if (!inString && !inChar) {
        if (char === '{') open++;
        else if (char === '}') close++;
      }

      i++;
    }

    return { open, close, inBlockComment };
  }

  isEscapedBackslash(line, index) {
    let count = 0;
    for (let i = index; i >= 0 && line[i] === '\\'; i--) count++;
    return count % 2 === 0;
  }
}

let instance = null;

export function getMethodChunker(options = {}) {
  if (!instance) instance = new MethodChunker(options);
  return instance;
}

export function resetMethodChunker() {
  instance = null;
}

export default MethodChunker;