import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CodexConfig } from '../domain/codex-config.js';
import { HarnessError } from '../domain/errors.js';
import type { CodexCredential } from './codex-credentials.js';

export const CODEX_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', properties: { path: { type: 'string', enum: ['src/message.mjs'] }, content: { type: 'string' } },
  required: ['path', 'content'], additionalProperties: false,
});
export type CodexTransport = (body: string, credential: CodexCredential, signal: AbortSignal) => Promise<Response>;

// 목적지·헤더는 부모가 만든다. CLI가 보낸 URL/credential/도구/추가 입력은 중계하지 않는다.
const sendToOpenAI: CodexTransport = (body, credential, signal) => fetch(credential.kind === 'api-key'
  ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses', {
  method: 'POST', headers: { Authorization: `Bearer ${credential.kind === 'api-key' ? credential.apiKey : credential.accessToken}`,
    'Content-Type': 'application/json', Accept: 'text/event-stream', ...(credential.kind === 'chatgpt' ? {
      'ChatGPT-Account-ID': credential.accountId, originator: 'codex_cli_rs', 'User-Agent': 'codex_cli_rs/0.154.0',
    } : {}) },
  body, redirect: 'error', signal,
});

export interface CodexBroker {
  port: number;
  capability: string;
  calls(): number;
  failure(): string | null;
  close(): Promise<void>;
}

/** 제공자가 반환한 SSE 또는 완성 JSON에서 도구 없는 완료 응답만 CLI 스트림으로 전달한다. */
export const normalizeCodexResponse = (raw: string, model: string, limit: number): string => {
  let completed: Record<string, unknown> | null = null;
  try {
    if (raw.trimStart().startsWith('{')) completed = JSON.parse(raw) as Record<string, unknown>;
    else for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim(); if (payload === '[DONE]') continue;
      const event = JSON.parse(payload) as { type?: string; response?: Record<string, unknown> };
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type ?? '')) throw new Error();
      if (event.type === 'response.completed') { if (completed) throw new Error(); completed = event.response ?? null; }
    }
    if (!completed || completed.status !== 'completed' || !Array.isArray(completed.output)) throw new Error();
    let text: string | null = null;
    for (const item of completed.output as { type?: string; role?: string; content?: { type?: string; text?: unknown }[] }[]) {
      if (item.type === 'reasoning') continue;
      if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length !== 1
        || item.content[0]?.type !== 'output_text' || typeof item.content[0].text !== 'string' || text !== null) throw new Error();
      text = item.content[0].text;
    }
    if (text === null || Buffer.byteLength(text) > limit) throw new Error();
    const item = { id: 'msg_harness', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: 'resp_harness', object: 'response', status: 'completed', model, output: [item],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    return [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  } catch { throw new HarnessError('CODEX_UPSTREAM_INVALID_RESPONSE'); }
};

export const startCodexBroker = async (
  config: CodexConfig, input: string, credential: CodexCredential, signal: AbortSignal,
  transport: CodexTransport = sendToOpenAI,
): Promise<CodexBroker> => {
  const secret = credential.kind === 'api-key' ? credential.apiKey : credential.accessToken;
  if (!secret || secret.length > 16384 || /[\r\n\0]/.test(secret)) throw new HarnessError('API_KEY_REQUIRED');
  const capability = randomBytes(32).toString('hex');
  let calls = 0;
  let receiving = false;
  let failure: string | null = null;
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const reject = (response: ServerResponse, code: number): void => {
    response.writeHead(code, { 'Content-Type': 'application/json' });
    response.end('{"error":{"message":"CODEX_BROKER_REJECTED"}}');
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const authorization = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${capability}`);
    if (request.method !== 'POST' || request.url !== '/v1/responses'
      || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)
      || request.headers['content-encoding'] !== undefined || controller.signal.aborted || calls !== 0 || receiving) {
      reject(response, 403); return;
    }
    receiving = true;
    try {
    let size = 0;
    const parts: Buffer[] = [];
    for await (const part of request) {
      const bytes = Buffer.from(part as Uint8Array); size += bytes.length;
      if (size > 256 * 1024) { reject(response, 413); return; }
      parts.push(bytes);
    }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>; }
    catch { reject(response, 400); return; }
    // 병렬 request도 body 수신 후 다시 검사한다. upstream은 작업당 정확히 한 번만 호출한다.
    if (!parsed || Array.isArray(parsed) || parsed.model !== config.model || parsed.stream !== true
      || calls !== 0 || controller.signal.aborted) { reject(response, 403); return; }
    calls += 1;
    const body = JSON.stringify({
      model: config.model, instructions: 'Return only the requested JSON patch proposal. No tools or actions are available.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
      tools: [], store: false, stream: true,
      ...(credential.kind === 'api-key' ? { max_output_tokens: 2048 } : {}),
      text: { format: { type: 'json_schema', name: 'synthetic_patch', strict: true, schema: CODEX_RESPONSE_SCHEMA } },
    });
    try {
      const result = await transport(body, credential, controller.signal);
      if (result.status !== 200 || !result.body) {
        failure = `CODEX_UPSTREAM_HTTP_${result.status}`;
        // 원문은 저장하지 않는다. 진단에 필요한 알려진 protocol field 이름만 정적 분류한다.
        if (result.body) {
          const chunks: Uint8Array[] = []; let bytes = 0;
          for await (const chunk of result.body) { bytes += chunk.length; if (bytes > 4096) break; chunks.push(chunk); }
          const error = Buffer.concat(chunks).toString('utf8');
          for (const field of ['tool_choice', 'max_output_tokens', 'text.format', 'instructions', 'model', 'account', 'token', 'stream', 'store']) {
            if (error.toLowerCase().includes(field)) { failure += `_${field.replace('.', '_').toUpperCase()}`; break; }
          }
        }
        reject(response, 502); return;
      }
      let received = 0; const chunks: Uint8Array[] = [];
      for await (const bytes of result.body) {
        received += bytes.length;
        if (received > 256 * 1024 || controller.signal.aborted) {
          failure = 'CODEX_UPSTREAM_LIMIT'; controller.abort(); response.destroy(); return;
        }
        chunks.push(bytes);
      }
      const stream = normalizeCodexResponse(Buffer.concat(chunks).toString('utf8'), config.model, config.maxResponseBytes);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.end(stream);
    } catch (error) {
      failure = controller.signal.aborted ? 'CODEX_CALL_ABORTED'
        : error instanceof HarnessError ? error.code : 'CODEX_UPSTREAM_FAILED';
      if (response.headersSent) response.destroy(); else reject(response, 502);
    }
    } finally { receiving = false; }
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { failure = 'CODEX_BROKER_FAILED'; response.destroy(); });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.maxConnections = 4;
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, rejectPromise) => {
    server.once('error', rejectPromise); server.listen(0, '127.0.0.1', () => { server.off('error', rejectPromise); resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port, capability, calls: () => calls, failure: () => failure,
    close: async () => {
      signal.removeEventListener('abort', abort); controller.abort(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
