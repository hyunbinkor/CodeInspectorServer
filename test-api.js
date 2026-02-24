#!/usr/bin/env node
/**
 * Code Quality Server - API Test Script (Node.js)
 *
 * Usage:
 *   node test-api.js [server-url]
 *   node test-api.js http://192.168.100.50:3000
 *
 * 파일 구조:
 *   data/
 *   ├── rules.json      - 규칙 데이터
 *   ├── tags.json       - 태그 데이터  
 *   └── demo-code.java  - 테스트 Java 코드
 * 
 * Heartbeat 지원:
 *   /api/check 엔드포인트는 장시간 처리 시 프록시 타임아웃 방지를 위해
 *   주기적으로 공백 문자를 전송합니다. 이 스크립트는 이를 자동 처리합니다.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const SERVER = process.argv[2] || 'http://localhost:3000';
const DATA_DIR = path.join(__dirname, 'data');

const FILES = {
    rules: path.join(DATA_DIR, 'rules.json'),
    tags: path.join(DATA_DIR, 'tags.json'),
    code: path.join(DATA_DIR, 'demo-code.java')
};

// ─────────────────────────────────────────────────────────────────────────────
// Colors
// ─────────────────────────────────────────────────────────────────────────────

const colors = {
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    blue: (s) => `\x1b[34m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    gray: (s) => `\x1b[90m${s}\x1b[0m`
};

const log = {
    header: (msg) => console.log(colors.blue(`\n${'═'.repeat(65)}\n  ${msg}\n${'═'.repeat(65)}`)),
    step: (num, msg) => console.log(colors.yellow(`\n[${num}] ${msg}\n${'─'.repeat(65)}`)),
    success: (msg) => console.log(colors.green(`✅ ${msg}`)),
    error: (msg) => console.log(colors.red(`❌ ${msg}`)),
    info: (msg) => console.log(colors.cyan(`ℹ️  ${msg}`)),
    heartbeat: (msg) => process.stdout.write(colors.gray(`\r  💓 ${msg}`)),
    json: (obj) => console.log(JSON.stringify(obj, null, 2))
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Client - 일반 API 호출용 (fetch)
// ─────────────────────────────────────────────────────────────────────────────

async function request(method, endpoint, body = null) {
    const url = `${SERVER}${endpoint}`;
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
   
    if (body) {
        options.body = JSON.stringify(body);
    }
   
    try {
        const response = await fetch(url, options);
        const text = await response.text();
       
        let data;
        try {
            data = JSON.parse(text.trim());
        } catch {
            data = text;
        }
       
        return {
            ok: response.ok,
            status: response.status,
            data
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            error: error.message
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Client - Heartbeat 스트리밍 대응 (http/https 모듈)
//
// /api/check는 처리 중 주기적으로 \n을 전송하여 프록시 연결을 유지합니다.
// fetch()는 전체 응답이 끝날 때까지 대기하므로 프록시가 중간에 끊을 수 있어
// http 모듈로 스트리밍 수신하여 heartbeat를 실시간 감지합니다.
// ─────────────────────────────────────────────────────────────────────────────

function requestStreaming(method, endpoint, body = null, timeoutMs = 600000) {
    return new Promise((resolve) => {
        const url = new URL(endpoint, SERVER);
        const httpModule = url.protocol === 'https:' ? https : http;
        const bodyStr = body ? JSON.stringify(body) : null;

        const reqOptions = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
            },
            rejectUnauthorized: false,  // 내부망 자체 서명 인증서 허용
            timeout: timeoutMs
        };

        const startTime = Date.now();
        let heartbeatCount = 0;

        const req = httpModule.request(reqOptions, (res) => {
            let fullData = '';

            res.setEncoding('utf-8');

            res.on('data', (chunk) => {
                fullData += chunk;

                // heartbeat 감지 (공백만 있는 청크)
                if (chunk.trim().length === 0 && chunk.length > 0) {
                    heartbeatCount++;
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
                    log.heartbeat(`heartbeat #${heartbeatCount} (${elapsed}초 경과, 서버 처리 중...)`);
                }
            });

            res.on('end', () => {
                if (heartbeatCount > 0) {
                    console.log('');  // heartbeat 줄 개행
                }

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                log.info(`응답 완료: ${elapsed}초, heartbeat ${heartbeatCount}회`);

                // heartbeat 공백 제거 후 JSON 파싱
                const jsonText = fullData.trim();
                let data;
                try {
                    data = JSON.parse(jsonText);
                } catch {
                    data = jsonText;
                }

                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    data,
                    heartbeatCount,
                    elapsedSec: parseFloat(elapsed)
                });
            });

            res.on('error', (err) => {
                if (heartbeatCount > 0) console.log('');
                resolve({
                    ok: false,
                    status: res.statusCode,
                    error: `Response error: ${err.message}`,
                    heartbeatCount
                });
            });
        });

        req.on('error', (err) => {
            resolve({
                ok: false,
                status: 0,
                error: err.message
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({
                ok: false,
                status: 0,
                error: `Timeout (${timeoutMs / 1000}초)`
            });
        });

        if (bodyStr) {
            req.write(bodyStr);
        }
        req.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// File Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fileExists(filePath) {
    return fs.existsSync(filePath);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readText(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Functions
// ─────────────────────────────────────────────────────────────────────────────

async function testHealth() {
    log.step('1/8', 'Health Check');
   
    const res = await request('GET', '/health');
   
    if (res.ok) {
        log.json(res.data);
        log.success(`Health check passed (HTTP ${res.status})`);
        return true;
    } else {
        log.error(`Health check failed: ${res.error || res.status}`);
        return false;
    }
}

async function testApiInfo() {
    log.step('2/8', 'API Info');
   
    const res = await request('GET', '/api');
   
    if (res.ok) {
        log.json(res.data);
        log.success(`API info retrieved (HTTP ${res.status})`);
        return true;
    } else {
        log.error(`API info failed: ${res.error || res.status}`);
        return false;
    }
}

async function testDataStatsInitial() {
    log.step('3/8', 'Data Stats (Before Push)');
   
    const res = await request('GET', '/api/data/stats');
   
    if (res.ok) {
        log.json(res.data);
        log.success(`Data stats retrieved (HTTP ${res.status})`);
        return true;
    } else {
        log.error(`Data stats failed: ${res.error || res.status}`);
        if (res.data) log.json(res.data);
        return false;
    }
}

async function testDataPush() {
    log.step('4/8', 'Data Push (Upload Rules & Tags)');
   
    // Check files
    if (!fileExists(FILES.rules)) {
        log.error(`File not found: ${FILES.rules}`);
        return false;
    }
    if (!fileExists(FILES.tags)) {
        log.error(`File not found: ${FILES.tags}`);
        return false;
    }
   
    // Load data
    const rulesData = readJson(FILES.rules);
    const tagsData = readJson(FILES.tags);
   
    // Build payload
    const rules = Array.isArray(rulesData) ? rulesData : (rulesData.rules || []);
   
    const payload = {
        rules: rules,
        tags: tagsData,
        force: true
    };
   
    log.info(`Sending ${rules.length} rules...`);
   
    const res = await request('POST', '/api/data/push', payload);
   
    if (res.ok) {
        log.json(res.data);
        log.success(`Data push successful (HTTP ${res.status})`);
        return true;
    } else {
        log.error(`Data push failed (HTTP ${res.status})`);
        if (res.data) log.json(res.data);
        return false;
    }
}

async function testDataPull() {
    log.step('5/8', 'Data Pull (Download Rules & Tags)');
   
    const res = await request('GET', '/api/data/pull');
   
    if (res.ok) {
        // Show truncated response
        const str = JSON.stringify(res.data, null, 2);
        console.log(str.substring(0, 1000) + (str.length > 1000 ? '\n... (truncated)' : ''));
       
        const ruleCount = res.data.rules?.length || res.data.rules?.count || '?';
        log.success(`Data pull successful (HTTP ${res.status}) - ${ruleCount} rules`);
        return true;
    } else {
        log.error(`Data pull failed: ${res.error || res.status}`);
        if (res.data) log.json(res.data);
        return false;
    }
}

async function testDataStatsAfter() {
    log.step('6/8', 'Data Stats (After Push)');
   
    const res = await request('GET', '/api/data/stats');
   
    if (res.ok) {
        log.json(res.data);
        log.success(`Data stats retrieved (HTTP ${res.status})`);
        return true;
    } else {
        log.error(`Data stats failed: ${res.error || res.status}`);
        if (res.data) log.json(res.data);
        return false;
    }
}

async function testCodeCheck() {
    log.step('7/8', 'Code Check (Main Test - Heartbeat Streaming)');
   
    if (!fileExists(FILES.code)) {
        log.error(`File not found: ${FILES.code}`);
        log.info('Create data/demo-code.java with test Java code');
        return false;
    }
   
    const code = readText(FILES.code);
    const fileName = path.basename(FILES.code);
    const lineCount = code.split('\n').length;
   
    const payload = {
        code: code,
        fileName: fileName,
        options: { format: 'json' }
    };
   
    log.info(`Sending ${code.length} chars (${lineCount} lines)...`);
    log.info(`Heartbeat 스트리밍 모드로 전송 (프록시 타임아웃 방지)`);
   
    // heartbeat 대응 스트리밍 요청 (타임아웃 10분)
    const res = await requestStreaming('POST', '/api/check', payload, 600000);
   
    if (res.ok) {
        // 결과 출력 (너무 길면 요약)
        if (typeof res.data === 'object') {
            const issueCount = res.data.issues?.length || 0;

            // 요약 먼저 출력
            console.log(`\n  결과 요약:`);
            console.log(`    성공:   ${res.data.success}`);
            console.log(`    파일:   ${res.data.fileName || fileName}`);
            console.log(`    이슈:   ${issueCount}개`);
            console.log(`    청킹:   ${res.data.chunked || false}`);

            if (res.data.summary?.bySeverity) {
                console.log(`    심각도:`);
                for (const [sev, count] of Object.entries(res.data.summary.bySeverity)) {
                    console.log(`      ${sev}: ${count}`);
                }
            }

            // 이슈 목록 (처음 10개만)
            if (issueCount > 0) {
                console.log(`\n  이슈 목록${issueCount > 10 ? ` (처음 10개 / 총 ${issueCount}개)` : ''}:`);
                const displayIssues = res.data.issues.slice(0, 10);
                for (const issue of displayIssues) {
                    const line = issue.line ? `L${issue.line}` : '';
                    console.log(`    [${issue.severity}] ${line} ${issue.title || issue.ruleId}`);
                }
                if (issueCount > 10) {
                    console.log(`    ... 외 ${issueCount - 10}개`);
                }
            }

            // 전체 결과 파일 저장
            const resultFile = path.join(DATA_DIR, 'check-result.json');
            fs.writeFileSync(resultFile, JSON.stringify(res.data, null, 2), 'utf-8');
            log.info(`전체 결과 저장: ${resultFile}`);
            
            log.success(`Code check completed (HTTP ${res.status}) - ${issueCount} issues (${res.elapsedSec}초, heartbeat ${res.heartbeatCount}회)`);
        } else {
            log.json(res.data);
            log.success(`Code check completed (HTTP ${res.status})`);
        }
        return true;
    } else {
        log.error(`Code check failed (HTTP ${res.status})`);
        if (res.error) log.error(res.error);
        if (res.data) {
            if (typeof res.data === 'string') {
                console.log(res.data.substring(0, 500));
            } else {
                log.json(res.data);
            }
        }
        if (res.heartbeatCount > 0) {
            log.info(`heartbeat ${res.heartbeatCount}회 수신 후 실패`);
        }
        return false;
    }
}

async function testCheckStats() {
    log.step('8/8', 'Check Stats (Filtering Statistics)');
   
    const res = await request('GET', '/api/check/stats');
   
    if (res.ok) {
        log.json(res.data);
        log.success(`Check stats retrieved (HTTP ${res.status})`);
        return true;
    } else {
        log.error(`Check stats failed: ${res.error || res.status}`);
        if (res.data) log.json(res.data);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    log.header('Code Quality Server - API Test Suite');
   
    console.log(`\nServer URL: ${SERVER}`);
    console.log(`Data Dir:   ${DATA_DIR}`);
    console.log(`Time:       ${new Date().toISOString()}`);
   
    // Check Node.js version (fetch requires 18+)
    const nodeVersion = parseInt(process.version.slice(1));
    if (nodeVersion < 18) {
        log.error(`Node.js 18+ required (current: ${process.version})`);
        process.exit(1);
    }
    log.success(`Node.js ${process.version}`);
   
    // Check data files
    console.log('\nChecking data files...');
    if (fileExists(FILES.rules)) log.success(`rules.json found`);
    else log.info(`rules.json not found (push test will skip)`);
   
    if (fileExists(FILES.tags)) log.success(`tags.json found`);
    else log.info(`tags.json not found (push test will skip)`);
   
    if (fileExists(FILES.code)) {
        const code = readText(FILES.code);
        const lineCount = code.split('\n').length;
        log.success(`demo-code.java found (${lineCount} lines, ${code.length} chars)`);
    } else {
        log.info(`demo-code.java not found (check test will skip)`);
    }
   
    // Run tests
    const tests = [
        testHealth,
        testApiInfo,
        testDataStatsInitial,
        testDataPush,
        testDataPull,
        testDataStatsAfter,
        testCodeCheck,
        testCheckStats
    ];
   
    let passed = 0;
    let failed = 0;
   
    for (const test of tests) {
        try {
            const result = await test();
            if (result) passed++;
            else failed++;
        } catch (error) {
            log.error(`Test error: ${error.message}`);
            failed++;
        }
    }
   
    // Summary
    log.header('Test Summary');
   
    console.log(`\nPassed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total:  ${passed + failed}\n`);
   
    if (failed === 0) {
        log.success('All tests passed!');
        process.exit(0);
    } else {
        log.error('Some tests failed');
        process.exit(1);
    }
}

main().catch(console.error);