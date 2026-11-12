import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeReadonlyModelPreflightResponse, type PreflightHttpResponse } from '../src/policy/readonly-model-preflight-protocol.js';

// Independently authored protocol envelope; no encoder-generated expected result.
const raw = Buffer.from('{"id":"resp_review","object":"response","status":"completed","model":"synthetic-investigator-v1","output":[{"id":"msg_review","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"{\\"answer\\":\\"review\\"}","annotations":[]}]}]}');

test('146 review: a terminal iterator result arriving past the deadline cannot complete successfully', async () => {
  let reads = 0;
  const response: PreflightHttpResponse = {
    status: 200,
    headers: [['Content-Type', 'application/json']],
    body: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            if (reads++ === 0) return { done: false, value: raw };
            // A synchronous untrusted producer can keep the timer callback from running.
            const deadline = performance.now() + 25;
            while (performance.now() < deadline) { /* Deliberate bounded event-loop stall. */ }
            return { done: true, value: undefined };
          },
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    },
  };
  await assert.rejects(decodeReadonlyModelPreflightResponse(response, 'responses-candidate-json-v1', new AbortController().signal,
    { workTimeoutMs: 10, cleanupTimeoutMs: 20 }), { code: 'READONLY_MODEL_PREFLIGHT_TIMEOUT' });
});

test('146 review: synchronous iterator cleanup past its deadline is uncertain even when return resolves', async () => {
  const controller = new AbortController(); controller.abort();
  const response: PreflightHttpResponse = { status: 200, headers: [['Content-Type', 'application/json']], body: {
    [Symbol.asyncIterator]() { return {
      next: async () => ({ done: true as const, value: undefined }),
      return: async () => {
        const deadline = performance.now() + 25;
        while (performance.now() < deadline) { /* Deliberate bounded event-loop stall. */ }
        return { done: true as const, value: undefined };
      },
    }; },
  } };
  await assert.rejects(decodeReadonlyModelPreflightResponse(response, 'responses-candidate-json-v1', controller.signal,
    { workTimeoutMs: 100, cleanupTimeoutMs: 10 }), { code: 'READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE' });
});
