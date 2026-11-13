import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyLiveConfig, ReadonlyLiveDispatch, ReadonlyLiveDecodedResponse, ReadonlyLiveProfileId } from '../domain/readonly-live.js';
import { assertReadonlyLiveDispatch } from '../policy/readonly-live-policy.js';
import { decodeReadonlyLiveResponse, getReadonlyLiveHttpLimits, getReadonlyLiveJsonDiagnostic, getReadonlyLiveSensitiveDiagnostic,
  getReadonlyLiveSensitiveAttribution, getReadonlyLiveSensitiveMatches, getReadonlyLiveSseDiagnostic, getReadonlyLiveSseEnvelopeDiagnostic, getReadonlyLiveResponseDiagnostic,
  type ReadonlyLiveJsonDiagnostic, type ReadonlyLiveSseDiagnostic } from '../policy/readonly-live-protocol.js';
import type { ReadonlyLiveSensitiveDiagnostic, ReadonlyLiveSensitiveAttribution, ReadonlyLiveSensitiveMatches } from '../policy/readonly-live-sensitive-diagnostics.js';
import type { ReadonlyLiveSseEnvelopeDiagnostic } from '../policy/readonly-live-sse-envelope-diagnostics.js';
import type { ReadonlyLiveResponseDiagnostic } from '../policy/readonly-live-protocol.js';
import { classifyReadonlyLiveHeaders, copyReadonlyLiveHeaderDiagnostics, type ReadonlyLiveHeaderDiagnostics } from '../policy/readonly-live-http-diagnostics.js';
import type { CodexCredential } from './codex-credentials.js';

export type ReadonlyLiveCredential = Extract<CodexCredential, { kind: 'chatgpt' }>;
export interface ReadonlyLiveHttpObservation {
  status: number; headerCount: number; headerBytes: number;
  headerDiagnostics?: ReadonlyLiveHeaderDiagnostics;
}
export type ReadonlyLiveTransport = (dispatch: ReadonlyLiveDispatch, credential: ReadonlyLiveCredential, signal: AbortSignal,
  observeHeaders: (observation: ReadonlyLiveHttpObservation) => void) => Promise<Response>;

/** Count all raw headers before dropping response cookies, which this client never stores or sends. */
export const selectReadonlyLiveResponseHeaders = (pairs: readonly string[], profileId: ReadonlyLiveProfileId): Headers => {
  const limits = getReadonlyLiveHttpLimits(profileId);
  const precise = profileId === 'codex-chatgpt-sse-v4' || profileId === 'codex-chatgpt-sse-v5' || profileId === 'codex-chatgpt-sse-v6'
    || profileId === 'codex-chatgpt-sse-v7' || profileId === 'codex-chatgpt-sse-v8' || profileId === 'codex-chatgpt-sse-v9';
  const modern = precise || profileId === 'codex-chatgpt-sse-v3';
  const invalid = (suffix: 'PAIR_SHAPE' | 'NAME_TOKEN' | 'VALUE_CHARACTER' | 'DUPLICATE_HEADER' | 'HEADERS_CONVERSION'): never => {
    const legacy = suffix === 'DUPLICATE_HEADER' ? suffix : 'HTTP_HEADERS';
    throw new HarnessError(precise ? `READONLY_LIVE_INVALID_RESPONSE_RAW_${suffix}`
      : modern ? `READONLY_LIVE_INVALID_RESPONSE_${legacy}` : 'READONLY_LIVE_INVALID_RESPONSE');
  };
  if (pairs.length % 2 !== 0 || pairs.some((part) => typeof part !== 'string')) invalid('PAIR_SHAPE');
  if (pairs.length / 2 > limits.headersCount
    || pairs.reduce((size, part) => size + Buffer.byteLength(part) + 2, 0) > limits.headersBytes) {
    throw new HarnessError('READONLY_LIVE_HEADER_LIMIT');
  }
  const names = new Set<string>(); const headers = new Headers();
  for (let index = 0; index < pairs.length; index += 2) {
    const name = pairs[index]!.toLowerCase(); const value = pairs[index + 1]!;
    if (modern && !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) invalid('NAME_TOKEN');
    if (modern && (precise ? /[^\t\x20-\x7e]/u.test(value) : /[^\x20-\x7e]/u.test(value))) invalid('VALUE_CHARACTER');
    // Set-Cookie legitimately repeats in HTTP. It grants no session state to this one-shot client.
    if (modern && name === 'set-cookie') continue;
    if (names.has(name)) invalid('DUPLICATE_HEADER');
    names.add(name);
    try { headers.set(pairs[index]!, value); } catch { invalid('HEADERS_CONVERSION'); }
  }
  return headers;
};

/** Only this trusted function adds credentials. URL and reviewed body are never supplied by the child. */
export const sendReadonlyLiveRequest: ReadonlyLiveTransport = (dispatch, credential, signal, observeHeaders) => new Promise((resolve, reject) => {
  const headers = Object.fromEntries(dispatch.requestEnvelope.headers);
  const limits = getReadonlyLiveHttpLimits(dispatch.requestEnvelope.profileId);
  const precise = dispatch.requestEnvelope.profileId === 'codex-chatgpt-sse-v4' || dispatch.requestEnvelope.profileId === 'codex-chatgpt-sse-v5'
    || dispatch.requestEnvelope.profileId === 'codex-chatgpt-sse-v6' || dispatch.requestEnvelope.profileId === 'codex-chatgpt-sse-v7'
    || dispatch.requestEnvelope.profileId === 'codex-chatgpt-sse-v8' || dispatch.requestEnvelope.profileId === 'codex-chatgpt-sse-v9';
  const request = httpsRequest('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST', agent: false, signal, maxHeaderSize: limits.headersBytes,
    headers: { ...headers, Authorization: `Bearer ${credential.accessToken}`, 'ChatGPT-Account-ID': credential.accountId,
      'Content-Length': Buffer.byteLength(dispatch.requestEnvelope.body) },
  }, (response) => {
    // Inspect raw pairs before Web Headers would merge duplicates.
    const pairs = response.rawHeaders;
    const headerCount = pairs.length / 2;
    const headerBytes = pairs.reduce((size, part) => size + Buffer.byteLength(part) + 2, 0);
    try { observeHeaders({ status: response.statusCode ?? 500, headerCount, headerBytes,
      headerDiagnostics: classifyReadonlyLiveHeaders(pairs) }); }
    catch { response.destroy(); reject(new HarnessError(precise
      ? 'READONLY_LIVE_INVALID_RESPONSE_RAW_OBSERVATION' : 'READONLY_LIVE_INVALID_RESPONSE')); return; }
    let webHeaders: Headers;
    try { webHeaders = selectReadonlyLiveResponseHeaders(pairs, dispatch.requestEnvelope.profileId); }
    catch (error) { response.destroy(); reject(error); return; }
    const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
    try { resolve(new Response(body, { status: response.statusCode ?? 500, headers: webHeaders })); }
    catch { response.destroy(); reject(new HarnessError(precise
      ? 'READONLY_LIVE_INVALID_RESPONSE_RAW_BODY' : dispatch.requestEnvelope.profileId === 'codex-chatgpt-sse-v3'
        ? 'READONLY_LIVE_INVALID_RESPONSE_BODY' : 'READONLY_LIVE_INVALID_RESPONSE')); }
  });
  request.once('error', (error) => {
    let code = 'READONLY_LIVE_CALL_FAILED';
    if (signal.aborted) code = 'READONLY_LIVE_CANCELLED';
    else if ('code' in error && error.code === 'HPE_HEADER_OVERFLOW') code = 'READONLY_LIVE_HEADER_LIMIT';
    else if (precise && 'code' in error
      && typeof error.code === 'string' && error.code.startsWith('HPE_')) code = 'READONLY_LIVE_INVALID_RESPONSE_RAW_NODE_PARSE';
    reject(new HarnessError(code));
  });
  request.end(dispatch.requestEnvelope.body);
});

export interface ReadonlyLiveBroker {
  port: number; capability: string; calls(): number; failure(): string | null;
  result(): ReadonlyLiveDecodedResponse | null; httpObservation(): ReadonlyLiveHttpObservation | null;
  jsonDiagnostic(): ReadonlyLiveJsonDiagnostic | null; sensitiveDiagnostic(): ReadonlyLiveSensitiveDiagnostic | null;
  sensitiveAttribution(): ReadonlyLiveSensitiveAttribution | null; sensitiveMatches(): ReadonlyLiveSensitiveMatches | null;
  sseDiagnostic(): ReadonlyLiveSseDiagnostic | null; sseEnvelopeDiagnostic(): ReadonlyLiveSseEnvelopeDiagnostic | null;
  responseDiagnostic(): ReadonlyLiveResponseDiagnostic | null; close(): Promise<void>;
}

/** This SSE is a CLI presentation envelope; it contains no invented usage/billing data. */
const cliResponse = (text: string, model: string): string => {
  const item = { id: 'msg_harness_readonly', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_harness_readonly', object: 'response', model, status: 'completed', output: [item] };
  return [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
};

export const startReadonlyLiveBroker = async (
  config: ReadonlyLiveConfig, dispatch: ReadonlyLiveDispatch, loadCredential: () => Promise<ReadonlyLiveCredential>,
  signal: AbortSignal, transport: ReadonlyLiveTransport, beforeTransmission: () => void,
): Promise<ReadonlyLiveBroker> => {
  assertReadonlyLiveDispatch(dispatch, config);
  if (typeof transport !== 'function' || typeof loadCredential !== 'function' || typeof beforeTransmission !== 'function') {
    throw new HarnessError('READONLY_LIVE_INVALID_TRANSPORT');
  }
  const approved = structuredClone(dispatch);
  approved.requestEnvelope.headers.forEach(Object.freeze); Object.freeze(approved.requestEnvelope.headers);
  Object.freeze(approved.requestEnvelope); Object.freeze(approved);
  const capability = randomBytes(32).toString('hex');
  let calls = 0; let receiving = false; let failure: string | null = null;
  let decoded: ReadonlyLiveDecodedResponse | null = null;
  let httpObservation: ReadonlyLiveHttpObservation | null = null;
  let jsonDiagnostic: ReadonlyLiveJsonDiagnostic | null = null;
  let sensitiveDiagnostic: ReadonlyLiveSensitiveDiagnostic | null = null;
  let sensitiveAttribution: ReadonlyLiveSensitiveAttribution | null = null;
  let sensitiveMatches: ReadonlyLiveSensitiveMatches | null = null;
  let sseDiagnostic: ReadonlyLiveSseDiagnostic | null = null;
  let sseEnvelopeDiagnostic: ReadonlyLiveSseEnvelopeDiagnostic | null = null;
  let responseDiagnostic: ReadonlyLiveResponseDiagnostic | null = null;
  const observeHeaders = (value: ReadonlyLiveHttpObservation): void => {
    const keys = value && Object.keys(value).sort().join(',');
    if (!value || (keys !== 'headerBytes,headerCount,status' && keys !== 'headerBytes,headerCount,headerDiagnostics,status')
      || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
      || !Number.isSafeInteger(value.headerCount) || value.headerCount < 0 || value.headerCount > 100_000
      || !Number.isSafeInteger(value.headerBytes) || value.headerBytes < 0 || value.headerBytes > 1_000_000
      || httpObservation !== null) throw new HarnessError('READONLY_LIVE_INVALID_RESPONSE');
    httpObservation = { status: value.status, headerCount: value.headerCount, headerBytes: value.headerBytes,
      ...(keys === 'headerBytes,headerCount,headerDiagnostics,status'
        ? { headerDiagnostics: copyReadonlyLiveHeaderDiagnostics(value.headerDiagnostics!) } : {}) };
  };
  const active = new Set<Promise<void>>();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const deny = (response: ServerResponse, status: number): void => {
    if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end('{"error":{"message":"READONLY_LIVE_BROKER_REJECTED"}}'); }
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const receivedAuth = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${capability}`);
    if (request.method !== 'POST' || request.url !== '/v1/responses' || receivedAuth.length !== expected.length
      || !timingSafeEqual(receivedAuth, expected) || request.headers['content-encoding'] !== undefined
      || receiving || calls !== 0 || controller.signal.aborted) { deny(response, 403); return; }
    receiving = true;
    try {
      const parts: Buffer[] = []; let size = 0;
      for await (const part of request) {
        const bytes = Buffer.from(part as Uint8Array); size += bytes.length;
        if (size > 256 * 1024) { deny(response, 413); return; } parts.push(bytes);
      }
      let childRequest: Record<string, unknown>;
      try { childRequest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as Record<string, unknown>; }
      catch { deny(response, 400); return; }
      if (!childRequest || Array.isArray(childRequest) || childRequest.model !== config.model || childRequest.stream !== true
        || calls !== 0 || controller.signal.aborted) { deny(response, 403); return; }
      assertReadonlyLiveDispatch(approved, config);
      const credential = await loadCredential();
      if (credential.kind !== 'chatgpt' || !credential.accessToken || credential.accessToken.length > 16384
        || !/^[a-zA-Z0-9_.-]+$/.test(credential.accessToken) || !/^[a-zA-Z0-9_-]{1,128}$/.test(credential.accountId)) {
        throw new HarnessError('READONLY_LIVE_INVALID_CREDENTIAL');
      }
      if (controller.signal.aborted) throw new HarnessError('READONLY_LIVE_CANCELLED');
      beforeTransmission();
      calls += 1;
      // Child input/tools/headers are ignored; the stored approval bytes are forwarded verbatim.
      const upstream = await transport(approved, credential, controller.signal, observeHeaders);
      try { decoded = await decodeReadonlyLiveResponse(upstream, controller.signal, { profileId: approved.requestEnvelope.profileId }); }
      catch (error) {
        // Only the local decoder can supply JSON categories; transport errors carry no response evidence.
        if (!controller.signal.aborted) {
          jsonDiagnostic = getReadonlyLiveJsonDiagnostic(error);
          sensitiveDiagnostic = getReadonlyLiveSensitiveDiagnostic(error);
          sensitiveAttribution = getReadonlyLiveSensitiveAttribution(error);
          sensitiveMatches = getReadonlyLiveSensitiveMatches(error);
          sseDiagnostic = getReadonlyLiveSseDiagnostic(error);
          sseEnvelopeDiagnostic = getReadonlyLiveSseEnvelopeDiagnostic(error);
          responseDiagnostic = getReadonlyLiveResponseDiagnostic(error);
        }
        throw error;
      }
      if (controller.signal.aborted) throw new HarnessError('READONLY_LIVE_CANCELLED');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.end(cliResponse(decoded.text, config.model));
    } catch (error) {
      failure = controller.signal.aborted ? 'READONLY_LIVE_CANCELLED'
        : error instanceof HarnessError && /^READONLY_LIVE_[A-Z0-9_]+$/.test(error.code) ? error.code : 'READONLY_LIVE_CALL_FAILED';
      decoded = null;
      if (response.headersSent) response.destroy(); else deny(response, 502);
    } finally { receiving = false; }
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const pending = handle(request, response).catch(() => { failure = 'READONLY_LIVE_CALL_FAILED'; response.destroy(); });
    active.add(pending); void pending.finally(() => active.delete(pending));
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.maxConnections = 4;
  server.on('connection', (socket) => { socket.setTimeout(55_000, () => socket.destroy()); });
  server.on('upgrade', (_request, socket) => socket.destroy()); server.on('connect', (_request, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  } catch { signal.removeEventListener('abort', abort); throw new HarnessError('READONLY_LIVE_BROKER_FAILED'); }
  return { port: (server.address() as AddressInfo).port, capability, calls: () => calls, failure: () => failure,
    result: () => decoded ? { ...decoded } : null,
    httpObservation: () => httpObservation ? structuredClone(httpObservation) : null,
    jsonDiagnostic: () => jsonDiagnostic ? { ...jsonDiagnostic } : null,
    sensitiveDiagnostic: () => sensitiveDiagnostic ? { ...sensitiveDiagnostic } : null,
    sensitiveAttribution: () => sensitiveAttribution ? { ...sensitiveAttribution } : null,
    sensitiveMatches: () => sensitiveMatches ? structuredClone(sensitiveMatches) : null,
    sseDiagnostic: () => sseDiagnostic ? { ...sseDiagnostic } : null,
    sseEnvelopeDiagnostic: () => sseEnvelopeDiagnostic ? structuredClone(sseEnvelopeDiagnostic) : null,
    responseDiagnostic: () => responseDiagnostic ? structuredClone(responseDiagnostic) : null,
    close: async () => {
      signal.removeEventListener('abort', abort); controller.abort(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all([...active]), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new HarnessError('READONLY_LIVE_LIFECYCLE_UNSAFE')), 5000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
};
