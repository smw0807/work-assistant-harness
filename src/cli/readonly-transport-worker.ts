import { assertReadonlyTransportWorkerBoundary } from '../adapters/readonly-transport-worker-contract.js';
import { buildReadonlyTransportFakeResponse } from '../policy/readonly-transport-policy.js';

// 신뢰하는 가짜 전송기다. 입력의 코드·문서·지시문을 실행하거나 도구로 해석하지 않는다.
const fail = (): never => process.exit(1);
process.on('disconnect', fail);
process.on('SIGTERM', fail);
process.on('SIGINT', fail);
process.stdout.on('error', fail);
const deadline = setTimeout(fail, 60_000);

const run = async (): Promise<void> => {
  // macOS가 최소 env에도 주입하는 표시 인코딩 힌트는 모델 경계에서 제거한다.
  delete process.env['__CF_USER_TEXT_ENCODING'];
  assertReadonlyTransportWorkerBoundary();
  process.send?.({ type: 'ready', pid: process.pid });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > 256 * 1024) throw new Error('READONLY_TRANSPORT_REQUEST_LIMIT');
    chunks.push(buffer);
  }
  const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const output = buildReadonlyTransportFakeResponse(input);
  if (output.byteLength > 256 * 1024) throw new Error('READONLY_TRANSPORT_RESPONSE_LIMIT');
  process.stdout.end(output, () => process.exit(0));
};

void run().catch(() => {
  process.stderr.write('READONLY_TRANSPORT_WORKER_FAILED\n', () => process.exit(1));
}).finally(() => clearTimeout(deadline));
