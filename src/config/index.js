/**
 * API 서버 설정
 * 
 * @module config/index
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 프로젝트 루트의 .env 파일 로드
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

export const config = {
  // 서버 설정
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: process.env.HOST || '0.0.0.0',
    env: process.env.NODE_ENV || 'development'
  },

  // vLLM 설정
  llm: {
    baseUrl: process.env.VLLM_BASE_URL || 'http://localhost:8000',
    model: process.env.VLLM_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct',
    timeout: parseInt(process.env.VLLM_TIMEOUT) || 180000,
    maxRetries: parseInt(process.env.VLLM_MAX_RETRIES) || 3,
    defaultSystemPrompt: 'You are an expert software developer specializing in Java code analysis.'
  },

  // Qdrant 설정
  qdrant: {
    host: process.env.QDRANT_HOST || 'localhost',
    port: parseInt(process.env.QDRANT_PORT) || 443,
    https: process.env.QDRANT_HTTPS,
    collectionName: process.env.QDRANT_COLLECTION || 'rules',
    issueCollectionName: process.env.QDRANT_ISSUE_COLLECTION || 'issues',
    tagCollectionName: process.env.QDRANT_TAG_COLLECTION || 'tag-definitions',
    vectorDimensions: 1536
  },

  // 경로 설정 (API 서버용)
  paths: {
    assets: {
      tags: process.env.TAGS_PATH || '/tmp/tags',
      schema: path.resolve(__dirname, '../../assets/schema')
    },
    backup: process.env.BACKUP_PATH || '/tmp/backup'
  },

  // 데이터 동기화 설정
  sync: {
    // Pull/Push 시 버전 관리
    enableVersioning: true,
    // Push 전 자동 백업
    autoBackup: true,
    // 백업 보관 개수
    maxBackups: 10
  },

  // 로깅 설정
  logging: {
    level: process.env.LOG_LEVEL || 'info'
  }
};

export default config;