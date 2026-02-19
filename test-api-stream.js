/**
 * SSE 스트리밍 API 테스트 클라이언트
 * 
 * 사용법:
 *   node test/test-api-stream.js [파일경로]
 *   node test/test-api-stream.js                    # 내장 샘플 코드 사용
 *   node test/test-api-stream.js ./MyService.java   # 파일 지정
 * 
 * 환경변수:
 *   API_BASE_URL - API 서버 주소 (기본: http://localhost:3000)
 */

import fs from 'fs';
import path from 'path';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// 샘플 Java 코드 (테스트용)
const SAMPLE_CODE = `
package com.example.service;

import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import javax.persistence.EntityManager;
import java.sql.Connection;
import java.sql.Statement;

@Service
public class OrderService {
    
    @Autowired
    private EntityManager entityManager;
    
    public void processOrder(String orderId, String userId) {
        // SQL Injection 취약점
        String query = "SELECT * FROM orders WHERE id = '" + orderId + "'";
        entityManager.createNativeQuery(query).getResultList();
        
        try {
            // 위험한 작업
            Connection conn = getConnection();
            Statement stmt = conn.createStatement();
            stmt.execute(query);
        } catch (Exception e) {
            // 빈 catch 블록
        }
    }
    
    public void validateInput(String input) {
        // Null 체크 없이 사용
        int length = input.length();
        System.out.println("Input length: " + length);
    }
    
    public void saveOrder(Order order) {
        // @Transactional 없이 여러 DB 작업
        entityManager.persist(order);
        entityManager.persist(order.getItems());
        entityManager.flush();
    }
    
    private Connection getConnection() {
        return null;
    }
}

class Order {
    public Object getItems() { return null; }
}
`;

/**
 * SSE 이벤트 파싱
 */
function parseSSEEvent(raw) {
  if (!raw.trim()) return null;

  const lines = raw.split('\n');
  let type = 'message';
  let data = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      type = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    }
  }

  try {
    return { type, data: data ? JSON.parse(data) : null };
  } catch (e) {
    return { type, data: { raw: data } };
  }
}

/**
 * 진행 상황 출력
 */
function handleProgress(data) {
  const { stage } = data;

  switch (stage) {
    case 'start':
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`📁 ${data.fileName} (${data.lineCount}줄) 검사 시작`);
      if (data.chunked) {
        console.log(`   📦 청킹 모드 활성화`);
      }
      console.log(`${'═'.repeat(60)}\n`);
      break;

    case 'tagging':
      console.log(`   ✓ 태깅 완료: ${data.tagCount}개 태그`);
      break;

    case 'rules':
      console.log(`   ✓ 룰 조회: ${data.ruleCount}개 매칭`);
      break;

    case 'filter':
      console.log(`   ✓ 필터링: 정규식 ${data.pureRegexCount}개, LLM 후보 ${data.llmCandidateCount}개`);
      break;

    case 'llm':
      process.stdout.write(`\r   ⏳ LLM 검증: ${data.current}/${data.total} (${data.ruleId})`);
      if (data.current === data.total) {
        console.log(' ✓');
      }
      break;

    case 'chunking':
      console.log(`   📦 청킹 완료: ${data.totalChunks}개 청크 (${data.totalMethods}개 메서드)`);
      break;

    case 'chunk_start':
      console.log(`\n   [${data.chunkIndex}/${data.chunkTotal}] ${data.methodName}`);
      if (data.lineRange) {
        console.log(`       라인: ${data.lineRange[0]}-${data.lineRange[1]}`);
      }
      break;

    case 'chunk_llm':
      process.stdout.write(`\r       ⏳ LLM: ${data.current}/${data.total} (${data.ruleId})`);
      if (data.current === data.total) {
        console.log('');
      }
      break;

    case 'chunk_done':
      if (data.error) {
        console.log(`       ❌ 실패: ${data.error}`);
      } else {
        console.log(`       ✅ 완료: ${data.issueCount}개 이슈 (${(data.elapsed / 1000).toFixed(1)}초)`);
      }
      break;

    case 'merging':
      if (data.status === 'start') {
        console.log(`\n   📋 결과 병합 중...`);
      } else {
        console.log(`   ✓ 병합 완료: ${data.totalIssues}개 이슈`);
      }
      break;

    default:
      console.log(`   [${stage}]`, data);
  }
}

/**
 * 최종 결과 출력
 */
function handleComplete(result) {
  console.log(`\n${'═'.repeat(60)}`);

  if (result.success) {
    console.log(`✅ 검사 완료: ${result.issues?.length || 0}개 이슈 발견`);
    console.log(`   처리 시간: ${(result.processingTimeMs / 1000).toFixed(1)}초`);

    if (result.summary) {
      const { bySeverity, byCategory } = result.summary;

      // 심각도별 출력
      if (bySeverity) {
        const severityStr = Object.entries(bySeverity)
          .filter(([_, count]) => count > 0)
          .map(([sev, count]) => {
            const icon = sev === 'HIGH' || sev === 'CRITICAL' ? '🔴' :
                         sev === 'MEDIUM' ? '🟡' : '🟢';
            return `${icon} ${sev}: ${count}`;
          })
          .join(' | ');

        if (severityStr) {
          console.log(`   심각도: ${severityStr}`);
        }
      }

      // 카테고리별 출력
      if (byCategory) {
        const categoryStr = Object.entries(byCategory)
          .map(([cat, count]) => `${cat}: ${count}`)
          .join(' | ');

        if (categoryStr) {
          console.log(`   분류: ${categoryStr}`);
        }
      }
    }

    // 이슈 목록 출력
    if (result.issues && result.issues.length > 0) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log('발견된 이슈:');
      console.log(`${'─'.repeat(60)}`);

      result.issues.forEach((issue, idx) => {
        const sevIcon = issue.severity === 'HIGH' || issue.severity === 'CRITICAL' ? '🔴' :
                        issue.severity === 'MEDIUM' ? '🟡' : '🟢';
        console.log(`\n${idx + 1}. ${sevIcon} [${issue.severity}] ${issue.title || issue.ruleId}`);
        console.log(`   위치: ${issue.line}줄`);
        console.log(`   규칙: ${issue.ruleId}`);
        if (issue.description) {
          console.log(`   설명: ${issue.description}`);
        }
        if (issue.suggestion) {
          console.log(`   제안: ${issue.suggestion}`);
        }
      });
    }
  } else {
    console.log(`❌ 검사 실패`);
  }

  console.log(`${'═'.repeat(60)}\n`);
}

/**
 * SSE 스트리밍 API 호출
 */
async function checkCodeWithStream(code, fileName = 'test.java') {
  console.log(`\n🔗 API 서버: ${API_BASE_URL}`);
  console.log(`📤 요청 전송 중...`);

  const startTime = Date.now();

  const response = await fetch(`${API_BASE_URL}/api/check/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      fileName,
      options: { format: 'json' }
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    // \n\n로 이벤트 분리
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || ''; // 마지막은 불완전할 수 있음

    for (const part of parts) {
      const event = parseSSEEvent(part);
      if (!event || !event.data) continue;

      switch (event.type) {
        case 'progress':
          handleProgress(event.data);
          break;

        case 'complete':
          finalResult = event.data;
          handleComplete(event.data);
          break;

        case 'error':
          console.error(`\n❌ 에러: ${event.data.message}`);
          break;

        default:
          console.log(`[${event.type}]`, event.data);
      }
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`⏱️  총 소요 시간: ${totalTime}초\n`);

  return finalResult;
}

/**
 * 메인 실행
 */
async function main() {
  try {
    let code = SAMPLE_CODE;
    let fileName = 'OrderService.java';

    // 파일 인자가 있으면 해당 파일 사용
    const filePath = process.argv[2];
    if (filePath) {
      const absolutePath = path.resolve(filePath);

      if (!fs.existsSync(absolutePath)) {
        console.error(`❌ 파일을 찾을 수 없습니다: ${absolutePath}`);
        process.exit(1);
      }

      code = fs.readFileSync(absolutePath, 'utf-8');
      fileName = path.basename(absolutePath);
      console.log(`📂 파일 로드: ${fileName} (${code.length}자)`);
    } else {
      console.log(`📝 내장 샘플 코드 사용 (${code.length}자)`);
    }

    await checkCodeWithStream(code, fileName);

  } catch (error) {
    console.error(`\n❌ 오류 발생:`, error.message);
    process.exit(1);
  }
}

main();