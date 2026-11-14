import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../domain/readonly-relay.js';
import { assertReadonlyRelayDispatch, getReadonlyRelayLimits } from '../policy/readonly-relay-policy.js';
import { assertReadonlyRelayCredentialText, collectReadonlyRelayResponse, type ReadonlyRelayReceptionOptions } from '../policy/readonly-relay-protocol.js';
import { copyReadonlyRelayReceptionDiagnostic, type ReadonlyRelayReceptionDiagnostic } from '../policy/readonly-relay-reception-diagnostics.js';
import type { CodexCredential } from './codex-credentials.js';

export type ReadonlyRelayCredential = Extract<CodexCredential, { kind: 'chatgpt' }>;
export interface ReadonlyRelayHttpObservation { status: number; headerCount: number; headerBytes: number }
export type ReadonlyRelayTransport = (dispatch: ReadonlyRelayDispatch, credential: ReadonlyRelayCredential, signal: AbortSignal,
  observeHeaders: (value: ReadonlyRelayHttpObservation) => void) => Promise<Response>;
const fail = (suffix: string): never => { throw new HarnessError(`READONLY_RELAY_${suffix}`); };

/** Cookies are counted and discarded; no upstream header is relayed to the child. */
export const selectReadonlyRelayResponseHeaders = (pairs: readonly string[]): Headers => {
  if (pairs.length % 2 || pairs.some((part) => typeof part !== 'string')) fail('INVALID_HTTP_HEADERS');
  if (pairs.length / 2 > 64 || pairs.reduce((size, part) => size + Buffer.byteLength(part) + 2, 0) > 16 * 1024) fail('HEADER_LIMIT');
  const names = new Set<string>(); const headers = new Headers();
  for (let index = 0; index < pairs.length; index += 2) {
    const name = pairs[index]!.toLowerCase(); const value = pairs[index + 1]!;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) || /[^\t\x20-\x7e]/u.test(value)) fail('INVALID_HTTP_HEADERS');
    if (name === 'set-cookie') continue;
    if (names.has(name)) fail('INVALID_HTTP_HEADERS');
    names.add(name);
    try { headers.set(name, value); } catch { fail('INVALID_HTTP_HEADERS'); }
  }
  return headers;
};

/** Fixed destination and verbatim approved bytes; no redirects, proxies, cookie jar or retry loop. */
export const sendReadonlyRelayRequest: ReadonlyRelayTransport = (dispatch, credential, signal, observeHeaders) => new Promise((resolve, reject) => {
  const request = httpsRequest('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST', agent: false, signal, maxHeaderSize: 16 * 1024,
    headers: { ...Object.fromEntries(dispatch.requestEnvelope.headers), Authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-ID': credential.accountId, 'Content-Length': Buffer.byteLength(dispatch.requestEnvelope.body) },
  }, (response) => {
    try {
      observeHeaders({ status: response.statusCode ?? 500, headerCount: response.rawHeaders.length / 2,
        headerBytes: response.rawHeaders.reduce((size, part) => size + Buffer.byteLength(part) + 2, 0) });
      const headers = selectReadonlyRelayResponseHeaders(response.rawHeaders);
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers }));
    } catch (error) {
      response.destroy(); reject(error instanceof HarnessError ? error : new HarnessError('READONLY_RELAY_INVALID_HTTP_RESPONSE'));
    }
  });
  request.once('error', () => reject(new HarnessError(signal.aborted ? 'READONLY_RELAY_CANCELLED' : 'READONLY_RELAY_CALL_FAILED')));
  request.end(dispatch.requestEnvelope.body);
});

export interface ReadonlyRelayBroker {
  port: number; capability: string; calls(): number; failure(): string | null;
  result(): { responseHash: string; bodyBytes: number; relayCompleted: true; credentialReflection: 'passed' } | null;
  httpObservation(): ReadonlyRelayHttpObservation | null;
  receptionDiagnostic(): ReadonlyRelayReceptionDiagnostic | null;
  verifyFinalText(text: string): void;
  close(): Promise<void>;
}

export const startReadonlyRelayBroker = async (
  config: ReadonlyRelayConfig, dispatch: ReadonlyRelayDispatch, loadCredential: () => Promise<ReadonlyRelayCredential>,
  signal: AbortSignal, transport: ReadonlyRelayTransport, beforeTransmission: () => void, beforeCredentialAccess: () => void,
): Promise<ReadonlyRelayBroker> => {
  assertReadonlyRelayDispatch(dispatch, config);
  if (![loadCredential, transport, beforeTransmission, beforeCredentialAccess].every((value) => typeof value === 'function')) fail('INVALID_TRANSPORT');
  if (signal.aborted) fail('CANCELLED');
  const approved = structuredClone(dispatch);
  approved.requestEnvelope.headers.forEach(Object.freeze); Object.freeze(approved.requestEnvelope.headers);
  Object.freeze(approved.requestEnvelope); Object.freeze(approved);
  const capability = randomBytes(32).toString('hex'); const controller = new AbortController();
  let reserved = false; let calls = 0; let failure: string | null = null;
  let finalTextGuard: ((text: string) => void) | null = null;
  let result: ReturnType<ReadonlyRelayBroker['result']> = null; let observation: ReadonlyRelayHttpObservation | null = null;
  let reception: ReadonlyRelayReceptionDiagnostic | null = null;
  const active = new Set<Promise<void>>();
  const observeHeaders = (value: ReadonlyRelayHttpObservation): void => {
    if (!value || Object.keys(value).sort().join(',') !== 'headerBytes,headerCount,status' || observation !== null
      || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
      || !Number.isSafeInteger(value.headerCount) || value.headerCount < 0 || value.headerCount > 100_000
      || !Number.isSafeInteger(value.headerBytes) || value.headerBytes < 0 || value.headerBytes > 1_000_000) fail('INVALID_HTTP_OBSERVATION');
    observation = { ...value };
  };
  const deny = (response: ServerResponse, status: number): void => {
    if (response.destroyed) return;
    if (response.headersSent) response.destroy();
    else response.writeHead(status, { 'Content-Type': 'application/json' }).end('{"error":{"message":"READONLY_RELAY_BROKER_REJECTED"}}');
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.on('error', () => response.destroy());
    const received = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${capability}`);
    if (request.method !== 'POST' || request.url !== '/v1/responses' || received.length !== expected.length || !timingSafeEqual(received, expected)
      || request.headers['content-encoding'] !== undefined || reserved || calls !== 0 || controller.signal.aborted) { deny(response, 403); return; }
    reserved = true;
    try {
      const parts: Buffer[] = []; let size = 0;
      for await (const part of request) {
        const bytes = Buffer.from(part as Uint8Array); size += bytes.length;
        if (size > 256 * 1024) { deny(response, 413); return; } parts.push(bytes);
      }
      let child: unknown;
      try { child = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
      catch { deny(response, 400); return; }
      if (!child || typeof child !== 'object' || Array.isArray(child) || (child as { model?: unknown }).model !== config.model
        || (child as { stream?: unknown }).stream !== true || controller.signal.aborted) { deny(response, 403); return; }
      assertReadonlyRelayDispatch(approved, config);
      beforeCredentialAccess();
      const loaded = await loadCredential();
      if (controller.signal.aborted) fail('CANCELLED');
      if (!loaded || ![Object.prototype, null].includes(Object.getPrototypeOf(loaded)) || Reflect.ownKeys(loaded).length !== 3) fail('INVALID_CREDENTIAL');
      const descriptors = Object.getOwnPropertyDescriptors(loaded);
      const kind = descriptors.kind; const token = descriptors.accessToken; const account = descriptors.accountId;
      if (![kind, token, account].every((field) => field && Object.hasOwn(field, 'value') && field.enumerable)
        || kind?.value !== 'chatgpt' || typeof token?.value !== 'string' || typeof account?.value !== 'string'
        || !/^[a-zA-Z0-9_.-]{12,16384}$/u.test(token.value) || !/^[a-zA-Z0-9_-]{12,128}$/u.test(account.value)) fail('INVALID_CREDENTIAL');
      const credential: ReadonlyRelayCredential = Object.freeze({ kind: 'chatgpt', accessToken: token!.value as string, accountId: account!.value as string });
      finalTextGuard = (text) => assertReadonlyRelayCredentialText(text, credential);
      if (controller.signal.aborted) fail('CANCELLED');
      beforeTransmission(); calls++;
      const upstream = await transport(approved, credential, controller.signal, observeHeaders);
      // Full bounded EOF and reflection checks precede the first byte sent to the uncredentialed child.
      const receptionOptions: ReadonlyRelayReceptionOptions | undefined = approved.requestEnvelope.profileId === 'codex-chatgpt-relay-v2'
        ? { responseBytes: getReadonlyRelayLimits(approved.requestEnvelope.profileId).responseBytes as NonNullable<ReadonlyRelayReceptionOptions['responseBytes']>,
          observeDiagnostic: (value) => { reception = copyReadonlyRelayReceptionDiagnostic(value); } } : undefined;
      const collected = await collectReadonlyRelayResponse(upstream, controller.signal, credential, receptionOptions);
      if (controller.signal.aborted) fail('CANCELLED');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { response.destroy(); reject(new HarnessError('READONLY_RELAY_CANCELLED')); };
        controller.signal.addEventListener('abort', abort, { once: true });
        response.once('close', () => { controller.signal.removeEventListener('abort', abort); if (!response.writableFinished) reject(new HarnessError('READONLY_RELAY_RESPONSE_CLOSED')); });
        response.end(collected.body, () => { controller.signal.removeEventListener('abort', abort); resolve(); });
        if (controller.signal.aborted) abort();
      });
      if (controller.signal.aborted) fail('CANCELLED');
      result = { responseHash: collected.responseHash, bodyBytes: collected.body.length, relayCompleted: true, credentialReflection: 'passed' };
    } catch (error) {
      result = null;
      finalTextGuard = null;
      const code = error instanceof HarnessError && /^READONLY_RELAY_[A-Z0-9_]+$/u.test(error.code) ? error.code : 'READONLY_RELAY_CALL_FAILED';
      failure = code === 'READONLY_RELAY_LIFECYCLE_UNSAFE' ? code : controller.signal.aborted ? 'READONLY_RELAY_CANCELLED' : code;
      deny(response, 502);
    }
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const pending = handle(request, response).catch(() => { failure = 'READONLY_RELAY_CALL_FAILED'; response.destroy(); });
    active.add(pending); void pending.finally(() => active.delete(pending));
  });
  const abort = (): void => { controller.abort(); server.closeAllConnections(); };
  signal.addEventListener('abort', abort, { once: true });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.maxConnections = 4;
  server.on('connection', (socket) => socket.setTimeout(55_000, () => socket.destroy()));
  server.on('upgrade', (_request, socket) => socket.destroy()); server.on('connect', (_request, socket) => socket.destroy());
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); }
  catch { signal.removeEventListener('abort', abort); fail('BROKER_FAILED'); }
  if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); await new Promise<void>((resolve) => server.close(() => resolve())); fail('CANCELLED'); }
  return { port: (server.address() as AddressInfo).port, capability, calls: () => calls, failure: () => failure,
    result: () => result ? { ...result } : null, httpObservation: () => observation ? { ...observation } : null,
    receptionDiagnostic: () => copyReadonlyRelayReceptionDiagnostic(reception),
    verifyFinalText: (text) => { if (!result || !finalTextGuard) fail('INVALID_RESPONSE'); finalTextGuard!(text); },
    close: async () => {
      signal.removeEventListener('abort', abort); abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), ...active]),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HarnessError('READONLY_RELAY_LIFECYCLE_UNSAFE')), 5000); })]);
      } finally { finalTextGuard = null; if (timer) clearTimeout(timer); }
    } };
};
