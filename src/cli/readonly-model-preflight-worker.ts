import { assertReadonlyModelPreflightWorkerBoundary } from '../adapters/readonly-model-preflight-worker-contract.js';
import type { ReadonlyModelPreflightDispatch } from '../domain/readonly-model-preflight.js';
import { assertReadonlyModelPreflightDispatch } from '../policy/readonly-model-preflight-policy.js';
import { buildReadonlyModelPreflightFakeHttpResponse, decodeReadonlyModelPreflightResponse } from '../policy/readonly-model-preflight-protocol.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

const fail = (): never => process.exit(1);
process.on('disconnect', fail); process.on('SIGTERM', fail); process.on('SIGINT', fail);
process.stdout.on('error', fail);
const deadline = setTimeout(fail, 60_000);

const run = async (): Promise<void> => {
  delete process.env['__CF_USER_TEXT_ENCODING'];
  assertReadonlyModelPreflightWorkerBoundary();
  process.send?.({ type: 'ready', pid: process.pid });
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += value.length;
    if (bytes > 1024 * 1024) throw new Error('READONLY_MODEL_PREFLIGHT_REQUEST_LIMIT');
    chunks.push(value);
  }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const request = parseReadonlyTransportJson(raw, 1024 * 1024) as ReadonlyModelPreflightDispatch;
  assertReadonlyModelPreflightDispatch(request);
  const response = buildReadonlyModelPreflightFakeHttpResponse(request.requestEnvelope.body);
  const output = await decodeReadonlyModelPreflightResponse(response, request.requestEnvelope.profileId, new AbortController().signal);
  const wire = JSON.stringify(output);
  if (Buffer.byteLength(wire) > 128 * 1024) throw new Error('READONLY_MODEL_PREFLIGHT_OUTPUT_LIMIT');
  process.stdout.end(wire, () => process.exit(0));
};

void run().catch(() => {
  process.stderr.write('READONLY_MODEL_PREFLIGHT_WORKER_FAILED\n', () => process.exit(1));
}).finally(() => clearTimeout(deadline));
