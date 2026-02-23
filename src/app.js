/**
 * Java 코드 품질 검사 API 서버
 * 
 * Express 기반 REST API 서버
 * 
 * @module app
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import checkRoutes from './api/routes/check.routes.js';
import dataRoutes from './api/routes/data.routes.js';
import { 
  errorHandler, 
  notFoundHandler, 
  requestLogger,
  jsonParseErrorHandler 
} from './api/middlewares/errorHandler.js';
import logger from './utils/loggerUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════
// 🔍 서버 시작 전 환경 진단 + 디렉토리 초기화
// ═══════════════════════════════════════════════════════════════════════════

async function checkPath(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    const type = stat.isDirectory() ? 'DIR ' : 'FILE';
    const mode = '0' + (stat.mode & 0o777).toString(8);
    const size = stat.isFile() ? ` (${stat.size} bytes)` : '';
    let writable = '?';
    try {
      await fs.access(targetPath, fsConstants.W_OK);
      writable = 'W';
    } catch {
      writable = 'R';
    }
    console.log(`  [${writable}] ${type} ${mode}  uid=${stat.uid} gid=${stat.gid}  ${targetPath}${size}`);
  } catch (error) {
    console.log(`  [X] MISSING  ${targetPath}  (${error.code})`);
  }
}

async function listDirectory(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    if (entries.length === 0) {
      console.log(`  ${dirPath}/ (비어있음)`);
    } else {
      for (const entry of entries) {
        const icon = entry.isDirectory() ? 'D' : 'F';
        const fullPath = path.join(dirPath, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          const mode = '0' + (stat.mode & 0o777).toString(8);
          const size = entry.isFile() ? ` (${stat.size}b)` : '';
          console.log(`  [${icon}] ${mode} uid=${stat.uid} gid=${stat.gid} ${entry.name}${size}`);
        } catch {
          console.log(`  [${icon}] ${entry.name} (stat 실패)`);
        }
      }
    }
  } catch (error) {
    console.log(`  ${dirPath} 읽기 실패: ${error.code}`);
  }
}

async function startupDiagnostic() {
  console.log('\n' + '='.repeat(60));
  console.log('DIAGNOSTIC START');
  console.log('='.repeat(60));

  // ── 1. 프로세스 정보 ──
  console.log('\n[1] Process Info');
  console.log(`  PID:      ${process.pid}`);
  console.log(`  UID:      ${process.getuid?.() ?? 'N/A'}`);
  console.log(`  GID:      ${process.getgid?.() ?? 'N/A'}`);
  console.log(`  CWD:      ${process.cwd()}`);
  console.log(`  Node:     ${process.version}`);
  console.log(`  Platform: ${process.platform}`);
  console.log(`  NODE_ENV: ${process.env.NODE_ENV}`);

  // ── 2. 경로 설정값 ──
  console.log('\n[2] Path Config');
  console.log(`  TAGS_PATH env:              ${process.env.TAGS_PATH || '(unset)'}`);
  console.log(`  BACKUP_PATH env:            ${process.env.BACKUP_PATH || '(unset)'}`);
  console.log(`  config.paths.assets.tags:   ${config.paths.assets.tags}`);
  console.log(`  config.paths.backup:        ${config.paths.backup}`);

  // ── 3. 디렉토리/파일 존재 + 권한 ──
  console.log('\n[3] Path Status');
  const pathsToCheck = [
    '/tmp',
    '/tmp/tags',
    '/tmp/backup',
    config.paths.assets.tags,
    config.paths.backup,
    '/app/assets',
    '/app/assets/tags',
    '/app/assets/tags/tag-definitions.json',
    '/scripts',
    '/scripts/entrypoint.sh',
    path.join(config.paths.assets.tags, 'tag-definitions.json'),
  ];
  for (const p of [...new Set(pathsToCheck)]) {
    await checkPath(p);
  }

  // ── 4. /tmp 내용 ──
  console.log('\n[4] /tmp contents');
  await listDirectory('/tmp');

  // ── 5. 설정된 tags 디렉토리 내용 ──
  console.log(`\n[5] ${config.paths.assets.tags} contents`);
  await listDirectory(config.paths.assets.tags);

  // ── 6. /app/assets/tags 내용 (원본) ──
  console.log('\n[6] /app/assets/tags contents');
  await listDirectory('/app/assets/tags');

  // ── 7. 마운트 정보 ──
  console.log('\n[7] Mounts (tmp/tags/backup/scripts related)');
  try {
    const mounts = await fs.readFile('/proc/mounts', 'utf-8');
    const relevant = mounts.split('\n').filter(
      line => line.includes('/tmp') || line.includes('tags') || 
              line.includes('backup') || line.includes('scripts')
    );
    if (relevant.length === 0) {
      console.log('  No relevant mounts found');
    } else {
      for (const m of relevant) {
        console.log(`  ${m}`);
      }
    }
    console.log(`  (Total mounts: ${mounts.split('\n').filter(l => l.trim()).length})`);
  } catch (e) {
    console.log(`  /proc/mounts read failed: ${e.code}`);
  }

  // ── 8. entrypoint.sh 내용 ──
  console.log('\n[8] /scripts/entrypoint.sh');
  try {
    const content = await fs.readFile('/scripts/entrypoint.sh', 'utf-8');
    for (const line of content.split('\n')) {
      console.log(`  | ${line}`);
    }
  } catch (e) {
    console.log(`  Read failed: ${e.code}`);
  }

  // ── 9. 디렉토리 생성 + 쓰기 테스트 ──
  console.log('\n[9] Directory Init + Write Test');
  const dirsToCreate = [config.paths.assets.tags, config.paths.backup];

  for (const dir of dirsToCreate) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`  mkdir OK: ${dir}`);
    } catch (e) {
      console.log(`  mkdir FAIL: ${dir} - ${e.code} ${e.message}`);
      continue;
    }

    const testFile = path.join(dir, '.write-test-' + Date.now());
    try {
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);
      console.log(`  write OK: ${dir}`);
    } catch (e) {
      console.log(`  write FAIL: ${dir} - ${e.code} ${e.message}`);
    }
  }

  // ── 10. 태그 파일 복사 시도 ──
  console.log('\n[10] Tag File Copy');
  const tagDest = path.join(config.paths.assets.tags, 'tag-definitions.json');
  try {
    await fs.access(tagDest);
    const stat = await fs.stat(tagDest);
    console.log(`  Already exists: ${tagDest} (${stat.size} bytes)`);
  } catch {
    console.log(`  Not found at: ${tagDest}`);
    const sources = [
      '/app/assets/tags/tag-definitions.json',
      path.resolve(__dirname, '../assets/tags/tag-definitions.json'),
    ];
    let copied = false;
    for (const src of sources) {
      try {
        await fs.copyFile(src, tagDest);
        const stat = await fs.stat(tagDest);
        console.log(`  Copied: ${src} -> ${tagDest} (${stat.size} bytes)`);
        copied = true;
        break;
      } catch (e) {
        console.log(`  Copy failed: ${src} - ${e.code}`);
      }
    }
    if (!copied) {
      console.log(`  WARNING: No tag file available`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('DIAGNOSTIC END');
  console.log('='.repeat(60) + '\n');
}

// 진단 실행
await startupDiagnostic();

// ═══════════════════════════════════════════════════════════════════════════
// Express 앱 생성
// ═══════════════════════════════════════════════════════════════════════════

const app = express();

// ═══════════════════════════════════════════════════════════════════════════
// 미들웨어 설정
// ═══════════════════════════════════════════════════════════════════════════

// CORS 설정
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON 바디 파서 (10MB 제한)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// JSON 파싱 에러 핸들러
app.use(jsonParseErrorHandler);

// 요청 로깅
app.use(requestLogger);

// ═══════════════════════════════════════════════════════════════════════════
// API 라우트
// ═══════════════════════════════════════════════════════════════════════════

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API 라우트 마운트
app.use('/api/check', checkRoutes);
app.use('/api/data', dataRoutes);

// API 정보
app.get('/api', (req, res) => {
  res.json({
    name: 'Code Quality API',
    version: '1.0.0',
    endpoints: {
      check: {
        'POST /api/check': '코드 검사 실행',
        'GET /api/check/stats': '필터링 통계 조회',
        'POST /api/check/stats/reset': '통계 리셋'
      },
      data: {
        'GET /api/data/pull': '전체 데이터 다운로드',
        'POST /api/data/diff': '변경사항 미리보기',
        'POST /api/data/push': '전체 데이터 업로드',
        'GET /api/data/stats': '데이터 통계 조회'
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 에러 핸들링
// ═══════════════════════════════════════════════════════════════════════════

// 404 핸들러
app.use(notFoundHandler);

// 글로벌 에러 핸들러
app.use(errorHandler);

// ═══════════════════════════════════════════════════════════════════════════
// 서버 시작
// ═══════════════════════════════════════════════════════════════════════════

const PORT = config.server.port;
const HOST = config.server.host;

app.listen(PORT, HOST, () => {
  console.log('\n' + '═'.repeat(60));
  console.log('🚀 Java 코드 품질 검사 API 서버');
  console.log('═'.repeat(60));
  console.log(`
  서버 주소:  http://${HOST}:${PORT}
  환경:       ${config.server.env}
  
  API 엔드포인트:
    POST /api/check          코드 검사
    GET  /api/data/pull      데이터 다운로드
    POST /api/data/diff      변경사항 미리보기
    POST /api/data/push      데이터 업로드
  
  헬스 체크:
    GET  /health
  
  API 문서:
    GET  /api
  `);
  console.log('═'.repeat(60) + '\n');
  
  logger.info(`서버 시작: http://${HOST}:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM 수신, 서버 종료 중...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT 수신, 서버 종료 중...');
  process.exit(0);
});

export default app;