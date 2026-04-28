/**
 * ESLint flat config — 최소 구성
 *
 * 방침: Prettier 도입 안 함 (현 코드의 박스 주석/정렬 스타일 보존).
 * 기존 코드와의 충돌을 줄이기 위해 recommended 룰셋만 적용하고,
 * 노이즈가 큰 몇 개 룰은 의도적으로 비활성화한다.
 *
 * 사용법:
 *   npm run lint        # 검사
 *   npm run lint:fix    # 자동 수정 (가능한 항목만)
 */

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'backup/**',
      'assets/**',
      '*.tar',
      '*.tar.gz'
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      // 핵심 룰만 강제
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['error', 'smart'],
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // catch (error)/(e)/(error2) 패턴은 의도적으로 무시한 것이라 경고 안 냄.
        // _ 접두사를 강제하면 기존 코드 광범위 수정 필요해 실용적으로 패턴 허용.
        caughtErrorsIgnorePattern: '^(_|e|err|error|error\\d*)$'
      }],

      // 노이즈 줄이기
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-console': 'off',                  // app.js startup diagnostic이 console 사용
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-escape': 'warn',          // 정규식에 의도적 이스케이프 다수
      'no-irregular-whitespace': 'off',     // 한글 주석에서 다양한 공백 허용

      // ESLint v10 신규 strict 룰 — 점진적으로 적용 예정이므로 일단 warn
      'preserve-caught-error': 'warn',      // catch에서 cause 첨부 권고
      'no-useless-assignment': 'warn'
    }
  },
  {
    // 인터페이스 파일은 시그니처 유지를 위해 unused 인자 허용
    // (flat config는 나중 항목이 우선이므로 메인 룰 뒤에 와야 효과 발휘)
    files: ['src/repositories/I*Repository.js'],
    rules: {
      'no-unused-vars': 'off'
    }
  }
];
