import { assertReadonlyWorkerBoundary } from '../adapters/readonly-worker-contract.js';
import { buildReadonlyMockResponse } from '../policy/readonly-investigation-policy.js';

// 신뢰하는 고정 모델이다. 입력의 코드·문서·지시문을 실행하거나 도구로 해석하지 않는다.
const fail = (): never => process.exit(1);
process.on('disconnect', fail);
process.on('SIGTERM', fail);
process.on('SIGINT', fail);
process.stdout.on('error', fail);
const deadline = setTimeout(fail, 60_000);

const run = async (): Promise<void> => {
  // macOS가 최소 env에도 주입하는 표시 인코딩 힌트는 모델 경계에서 제거한다.
  delete process.env['__CF_USER_TEXT_ENCODING'];
  assertReadonlyWorkerBoundary();
  process.send?.({ type: 'ready', pid: process.pid });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > 128 * 1024) throw new Error('READONLY_INPUT_LIMIT');
    chunks.push(buffer);
  }
  const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const output = buildReadonlyMockResponse(input);
  if (Buffer.byteLength(output) > 16 * 1024) throw new Error('READONLY_OUTPUT_LIMIT');
  process.stdout.end(output, () => process.exit(0));
};

void run().catch(() => {
  process.stderr.write('READONLY_MODEL_WORKER_FAILED\n', () => process.exit(1));
}).finally(() => clearTimeout(deadline));
