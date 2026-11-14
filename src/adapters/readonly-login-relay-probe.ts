import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { CodexConfig } from '../domain/codex-config.js';
import { HarnessError } from '../domain/errors.js';
import { parseReadonlyJson, READONLY_OUTPUT_SCHEMA } from '../policy/readonly-investigation-policy.js';
import { codexProposalArguments } from './codex-cli-contract.js';
import { probeCodexIsolation, runSandboxedCodex, verifyCodexBinary } from './codex-isolation.js';
import { createReadonlyLiveLifecycle, readonlyLiveCleanupConfirmed, readonlyLiveScratchIdentity, removeReadonlyLiveScratch,
  type ReadonlyLiveScratchIdentity } from './readonly-live-lifecycle.js';
import { runReadonlyLiveProcess } from './readonly-live-runner.js';

const version = 'synthetic-readonly-login-relay-probe-v1';
const binaryHash = '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc';
const fixtures = ['access-programs', 'invalid-json', 'incomplete', 'oversized', 'early-close', 'stall'] as const;
export type ReadonlyLoginRelayFixtureId = typeof fixtures[number];
const limit = 256 * 1024;
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const fail = (suffix: string): never => { throw new HarnessError(`READONLY_LOGIN_RELAY_${suffix}`); };
const fixtureId = (value: unknown): ReadonlyLoginRelayFixtureId => {
  if (typeof value !== 'string' || !(fixtures as readonly string[]).includes(value)) fail('INVALID_FIXTURE');
  return value as ReadonlyLoginRelayFixtureId;
};
const report = Object.freeze({ classification: 'insufficient-evidence', summary: 'Synthetic raw SSE relay fixture.', facts: [], hypotheses: [],
  answerDraft: 'No real model or login was used.', questions: [], suggestions: [], limitations: ['Only fixed synthetic output was checked.'] });
const reportText = JSON.stringify(report);
const requestBody = JSON.stringify({ model: 'gpt-6.1-sol', instructions: 'Return only the fixed synthetic investigation JSON. No tools or actions are available.',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Offline-only relay compatibility probe.' }] }],
  tools: [], store: false, stream: true,
  text: { format: { type: 'json_schema', name: 'readonly_relay_probe', strict: true, schema: READONLY_OUTPUT_SCHEMA } } });

/** Registered fake data only: these bytes are not a captured provider response or a schema commitment. */
export const readonlyLoginRelayFixture = (value: ReadonlyLoginRelayFixtureId): { requestBody: string; responseBody: Buffer } => {
  const selected = fixtureId(value);
  const text = selected === 'invalid-json' ? '{"unexpected":"synthetic"}' : reportText;
  const message = { id: 'msg_relay_synthetic', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_relay_synthetic', object: 'response', model: 'gpt-6.1-sol', status: 'completed', output: [message],
    access_programs: { cyber: 'standard' }, opaque_metadata: { enabled: true, label: 'synthetic' }, opaque_counter: 7 };
  const events = [{ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: message },
    { type: 'response.completed', sequence_number: 2, response }];
  if (selected === 'incomplete') events.pop();
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return { requestBody, responseBody: selected === 'oversized' ? Buffer.alloc(limit + 1, 32) : Buffer.from(body) };
};

export interface ReadonlyLoginRelayFixtureBroker {
  port: number; capability: string;
  observation(): { fakeDispatches: number; rejectedRequests: number; requestBodyHash: string | null; responseBodyHash: string | null;
    relayedBytes: number; relayCompleted: boolean; failureCode: string | null };
  close(): Promise<void>;
}
const waitForDrain = (response: ServerResponse, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const finish = (error = false): void => {
    response.off('drain', drained); response.off('close', closed); response.off('error', closed); signal.removeEventListener('abort', aborted);
    if (error) reject(new HarnessError('READONLY_LOGIN_RELAY_CLOSED')); else resolve();
  };
  const drained = (): void => finish(); const closed = (): void => finish(true); const aborted = (): void => finish(true);
  response.once('drain', drained); response.once('close', closed); response.once('error', closed); signal.addEventListener('abort', aborted, { once: true });
  if (response.destroyed || signal.aborted) finish(true);
});

/** A localhost-only fake relay. It cannot receive an upstream URL, credential loader, transport or fallback. */
export const startReadonlyLoginRelayFixtureBroker = async (
  value: ReadonlyLoginRelayFixtureId, signal: AbortSignal,
): Promise<ReadonlyLoginRelayFixtureBroker> => {
  const selected = fixtureId(value); const fixture = readonlyLoginRelayFixture(selected);
  if (!(signal instanceof AbortSignal) || signal.aborted) fail('ABORTED');
  const controller = new AbortController(); const capability = randomBytes(32).toString('hex');
  let receiving = false; let calls = 0; let rejected = 0; let bodyHash: string | null = null;
  let responseHash: string | null = null; let relayedBytes = 0; let relayCompleted = false; let failureCode: string | null = null;
  const active = new Set<Promise<void>>();
  const deny = (response: ServerResponse, status: number): void => {
    rejected++;
    if (!response.destroyed && !response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json' }).end('{"error":"SYNTHETIC_RELAY_REJECTED"}');
    else response.destroy();
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.on('error', () => response.destroy());
    const authorization = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${capability}`);
    if (request.method !== 'POST' || request.url !== '/v1/responses' || authorization.length !== expected.length
      || !timingSafeEqual(authorization, expected) || request.headers['content-encoding'] !== undefined
      || receiving || calls !== 0 || controller.signal.aborted) { deny(response, 403); return; }
    receiving = true;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of request) {
        const chunk = Buffer.from(part as Uint8Array); size += chunk.length;
        if (size > limit) { deny(response, 413); return; } chunks.push(chunk);
      }
      let child: unknown;
      try { child = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { deny(response, 400); return; }
      if (!child || typeof child !== 'object' || Array.isArray(child) || (child as { model?: unknown }).model !== 'gpt-6.1-sol'
        || (child as { stream?: unknown }).stream !== true || controller.signal.aborted || calls !== 0) { deny(response, 403); return; }
      // The child's input/tools/headers never determine the fake dispatch bytes.
      calls++; bodyHash = sha256(fixture.requestBody);
      if (fixture.responseBody.length > limit) { failureCode = 'READONLY_LOGIN_RELAY_RESPONSE_LIMIT'; deny(response, 502); return; }
      if (selected === 'stall') {
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      responseHash = sha256(fixture.responseBody);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      for (let offset = 0; offset < fixture.responseBody.length; offset += 8192) {
        if (controller.signal.aborted || response.destroyed) fail('ABORTED');
        const chunk = fixture.responseBody.subarray(offset, offset + 8192);
        if (selected === 'early-close') { response.write(chunk.subarray(0, 17)); relayedBytes += Math.min(chunk.length, 17); response.destroy(); return; }
        const ready = response.write(chunk); relayedBytes += chunk.length;
        if (!ready) await waitForDrain(response, controller.signal);
      }
      await new Promise<void>((resolve, reject) => {
        response.once('finish', resolve); response.once('close', () => { if (!response.writableFinished) reject(new HarnessError('READONLY_LOGIN_RELAY_CLOSED')); });
        response.end();
      });
      relayCompleted = true;
    } catch { failureCode ??= controller.signal.aborted ? 'READONLY_LOGIN_RELAY_ABORTED' : 'READONLY_LOGIN_RELAY_REQUEST_FAILED'; response.destroy(); }
    finally { receiving = false; }
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const pending = handle(request, response); active.add(pending); void pending.finally(() => active.delete(pending));
  });
  const abort = (): void => { controller.abort(); server.closeAllConnections(); };
  signal.addEventListener('abort', abort, { once: true });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.maxConnections = 4;
  server.on('connection', (socket) => socket.setTimeout(55_000, () => socket.destroy()));
  server.on('upgrade', (_request, socket) => socket.destroy()); server.on('connect', (_request, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  } catch { signal.removeEventListener('abort', abort); fail('BROKER_FAILED'); }
  if (signal.aborted || controller.signal.aborted) {
    signal.removeEventListener('abort', abort); abort();
    await new Promise<void>((resolve) => server.close(() => resolve())); fail('ABORTED');
  }
  return { port: (server.address() as AddressInfo).port, capability,
    observation: () => ({ fakeDispatches: calls, rejectedRequests: rejected, requestBodyHash: bodyHash, responseBodyHash: responseHash, relayedBytes, relayCompleted, failureCode }),
    close: async () => {
      signal.removeEventListener('abort', abort); abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([...active]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HarnessError('READONLY_LOGIN_RELAY_CLEANUP_UNCERTAIN')), 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
    } };
};

/** Probe-only stdout state machine; it does not change the existing Codex event parser. */
export const parseReadonlyLoginRelayProbeOutput = (output: string): typeof report => {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 128 * 1024) fail('OUTPUT_LIMIT');
  let state: 'initial' | 'thread' | 'turn' | 'message' | 'completed' = 'initial'; let text: string | null = null; let warning = false; let messageStarted = false;
  const unicode = (value: unknown): boolean => {
    if (typeof value === 'string') return Buffer.from(value).toString('utf8') === value;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(unicode);
    return !value || typeof value !== 'object' || Object.entries(value).every(([key, child]) => unicode(key) && unicode(child));
  };
  for (const line of output.split('\n').filter(Boolean)) {
    let value: unknown;
    try { value = parseReadonlyJson(line); } catch { fail('INVALID_OUTPUT'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !unicode(value)) fail('INVALID_OUTPUT');
    const event = value as { type?: string; item?: { type?: string; text?: unknown; message?: unknown } };
    if (event.type === 'thread.started' && state === 'initial') { state = 'thread'; continue; }
    if (event.type === 'item.completed' && event.item?.type === 'error' && !warning && ['thread', 'turn'].includes(state)
      && event.item.message === 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.') { warning = true; continue; }
    if (event.type === 'turn.started' && state === 'thread') { state = 'turn'; continue; }
    if (event.type === 'item.started' && event.item?.type === 'agent_message' && state === 'turn' && !messageStarted) { messageStarted = true; continue; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && state === 'turn'
      && typeof event.item.text === 'string' && Buffer.byteLength(event.item.text) <= 16384) { text = event.item.text; state = 'message'; continue; }
    if (event.type === 'turn.completed' && state === 'message') { state = 'completed'; continue; }
    fail('INVALID_OUTPUT');
  }
  if (state !== 'completed' || text === null) fail('INVALID_OUTPUT');
  let value: unknown;
  try { value = parseReadonlyJson(text!); } catch { fail('INVALID_JSON'); }
  if (JSON.stringify(value) !== reportText) fail('INVALID_JSON');
  return JSON.parse(reportText) as typeof report;
};

export interface ReadonlyLoginRelayProbeOptions {
  dataDirectory: string; codexPath: string; fixtureId: ReadonlyLoginRelayFixtureId; timeoutMs?: number; signal?: AbortSignal;
}
export interface ReadonlyLoginRelayProbeResult {
  version: typeof version; mode: 'offline-only'; fixtureId: ReadonlyLoginRelayFixtureId; investigationId: string;
  status: 'passed' | 'failed'; failureCode: string | null; fakeDispatches: number; rejectedRequests: number;
  requestBodyHash: string; dispatchedRequestBodyHash: string | null; responseBodyHash: string | null; relayedBytes: number; relayCompleted: boolean;
  isolation: 'passed' | 'not_run'; cleanupConfirmed: boolean; realCredentialAccess: 'not_run'; externalModelCalls: 0; liveReady: false;
  finalJson: typeof report | null; limitations: string[];
}

/** This isolated experiment accepts only registered fake data; no approval, live adapter or login loader is wired. */
export const runReadonlyLoginRelayProbe = async (options: ReadonlyLoginRelayProbeOptions): Promise<ReadonlyLoginRelayProbeResult> => {
  if (!options || typeof options !== 'object' || Reflect.ownKeys(options).some((key) => !['dataDirectory', 'codexPath', 'fixtureId', 'timeoutMs', 'signal'].includes(key as string))
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || ['dataDirectory', 'codexPath', 'fixtureId'].some((key) => !Object.hasOwn(options, key))) fail('INVALID_OPTIONS');
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    const property = Object.getOwnPropertyDescriptor(options, key); if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) fail('INVALID_OPTIONS');
    snapshot[key as string] = property!.value;
  }
  options = snapshot as unknown as ReadonlyLoginRelayProbeOptions;
  if (typeof options.dataDirectory !== 'string' || typeof options.codexPath !== 'string') fail('INVALID_OPTIONS');
  const selected = fixtureId(options.fixtureId); const timeoutMs = options.timeoutMs ?? 55_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000 || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) fail('INVALID_OPTIONS');
  if (options.signal?.aborted) fail('ABORTED');
  const config: CodexConfig = { enabled: true, policyVersion: 'codex-cli-proposal-v1', codexPath: options.codexPath,
    codexSha256: binaryHash, model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
  try { await verifyCodexBinary(config); } catch (error) { if (error instanceof HarnessError) throw error; fail('BINARY_UNAVAILABLE'); }
  const where = { dataDirectory: options.dataDirectory, investigationId: randomUUID() };
  const hashes = { requestBodyHash: sha256(requestBody), connectionProfileHash: sha256(`${version}:${selected}:${binaryHash}`),
    requestEnvelopeHash: sha256(`${version}:${selected}:${sha256(requestBody)}`) };
  const lifecycle = createReadonlyLiveLifecycle(where, hashes); const workspace = join(lifecycle.directory, 'sandbox'); const home = join(workspace, 'home');
  const controller = new AbortController(); let timedOut = false;
  const abort = (): void => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  let broker: ReadonlyLoginRelayFixtureBroker | null = null; let scratch: ReadonlyLiveScratchIdentity | null = null;
  let failureCode: string | null = null; let isolation = false; let cleanupConfirmed: boolean; let nativeUncertain = false; let finalJson: typeof report | null = null;
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    const settled = operation.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    let notify: () => void = () => {};
    const cancelled = new Promise<null>((resolve) => { notify = () => resolve(null); });
    controller.signal.addEventListener('abort', notify, { once: true }); if (controller.signal.aborted) notify();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([settled, cancelled]);
      if (outcome !== null) { if (outcome.error !== null) throw outcome.error; return outcome.value as T; }
      const cleanup = await Promise.race([settled, new Promise<null>((resolve) => { cleanupTimer = setTimeout(() => resolve(null), 5000); })]);
      if (cleanup === null) { nativeUncertain = true; return fail('CLEANUP_UNCERTAIN'); }
      return fail(timedOut ? 'TIMEOUT' : 'ABORTED');
    } finally { controller.signal.removeEventListener('abort', notify); if (cleanupTimer) clearTimeout(cleanupTimer); }
  };
  try {
    await mkdir(workspace, { mode: 0o700 }); scratch = readonlyLiveScratchIdentity(where); await mkdir(home, { mode: 0o700 });
    await writeFile(join(workspace, 'schema.json'), JSON.stringify(READONLY_OUTPUT_SCHEMA), { flag: 'wx', mode: 0o400 });
    broker = await startReadonlyLoginRelayFixtureBroker(selected, controller.signal);
    await bounded(probeCodexIsolation(lifecycle.directory, workspace, broker.port, controller.signal));
    const environment = { HOME: home, CODEX_HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HARNESS_CODEX_CAPABILITY: broker.capability };
    const foundVersion = await bounded(runSandboxedCodex(config.codexPath, ['--version'], workspace, broker.port, environment, '', controller.signal, 4096));
    if (foundVersion.trim() !== 'codex-cli 0.154.0') fail('BINARY_VERSION');
    isolation = true; lifecycle.running();
    const output = await bounded(runReadonlyLiveProcess(config.codexPath, codexProposalArguments(config, workspace, broker.port), workspace,
      broker.port, environment, requestBody, controller.signal, where));
    if (controller.signal.aborted) fail(timedOut ? 'TIMEOUT' : 'ABORTED');
    const observation = broker.observation();
    if (observation.failureCode || observation.fakeDispatches !== 1 || observation.requestBodyHash !== hashes.requestBodyHash
      || !observation.relayCompleted || observation.rejectedRequests !== 0) fail('DISPATCH_FAILED');
    finalJson = parseReadonlyLoginRelayProbeOutput(output);
  } catch (error) {
    failureCode = timedOut ? 'READONLY_LOGIN_RELAY_TIMEOUT' : options.signal?.aborted ? 'READONLY_LOGIN_RELAY_ABORTED'
      : broker?.observation().failureCode ?? (error instanceof HarnessError ? error.code : 'READONLY_LOGIN_RELAY_PROBE_FAILED');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    try {
      await broker?.close(); if (nativeUncertain) fail('CLEANUP_UNCERTAIN');
      if (scratch) removeReadonlyLiveScratch(where, scratch); lifecycle.closed();
      cleanupConfirmed = readonlyLiveCleanupConfirmed(options.dataDirectory, where.investigationId, hashes);
    } catch { cleanupConfirmed = false; }
  }
  if (!cleanupConfirmed) { failureCode = 'READONLY_LOGIN_RELAY_CLEANUP_UNCERTAIN'; finalJson = null; }
  const observation = broker?.observation();
  const result: ReadonlyLoginRelayProbeResult = { version, mode: 'offline-only', fixtureId: selected, investigationId: where.investigationId,
    status: failureCode ? 'failed' : 'passed', failureCode, fakeDispatches: observation?.fakeDispatches ?? 0, rejectedRequests: observation?.rejectedRequests ?? 0,
    requestBodyHash: hashes.requestBodyHash, dispatchedRequestBodyHash: observation?.requestBodyHash ?? null,
    responseBodyHash: observation?.responseBodyHash ?? null, relayedBytes: observation?.relayedBytes ?? 0, relayCompleted: observation?.relayCompleted ?? false,
    isolation: isolation ? 'passed' : 'not_run', cleanupConfirmed, realCredentialAccess: 'not_run', externalModelCalls: 0, liveReady: false, finalJson,
    limitations: ['Registered synthetic bytes only; real access_programs shape is unverified.', 'No provider SSE schema, sequence or private-metadata validation.',
      'Exact fixture JSON equality only; evidence selection, citations and model reasoning are not evaluated.', 'Buffered fixtures do not establish arbitrary upstream streaming compatibility.',
      'Native abort wait and broker active-handler wait each have a separate 5s budget; no end-to-end cleanup deadline is established.'] };
  await writeFile(join(lifecycle.directory, 'relay-probe-report.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return result;
};
