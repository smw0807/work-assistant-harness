import { createHash } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyModelPreflightDecodedResponse, ReadonlyModelPreflightProfileId } from '../domain/readonly-model-preflight.js';
import { canonicalReadonlyJson, readonlyExactKeys } from './readonly-investigation-policy.js';
import { assertReadonlyModelPreflightRequestBody, buildReadonlyModelPreflightFakeReport } from './readonly-model-preflight-policy.js';
import { parseReadonlyTransportJson } from './readonly-transport-protocol.js';
import { containsSensitiveText } from './redaction.js';

export interface PreflightHttpResponse { status: number; headers: [string, string][]; body: AsyncIterable<Uint8Array> }
export interface PreflightDecodeOptions { workTimeoutMs?: number; cleanupTimeoutMs?: number }
export const PREFLIGHT_HTTP_LIMITS = Object.freeze({ headersBytes: 8 * 1024, headersCount: 16,
  responseBytes: 256 * 1024, frameBytes: 64 * 1024, frames: 2048, outputBytes: 16 * 1024,
  workTimeoutMs: 55_000, cleanupTimeoutMs: 5_000 });
const fail = (suffix = 'INVALID_RESPONSE'): never => { throw new HarnessError(`READONLY_MODEL_PREFLIGHT_${suffix}`); };
const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!readonlyExactKeys(value, keys)) fail();
  return value as Record<string, unknown>;
};
const parse = (raw: string): Record<string, unknown> => {
  try { return parseReadonlyTransportJson(raw) as Record<string, unknown>; } catch { return fail(); }
};
const outputText = (text: unknown): string => {
  if (typeof text !== 'string' || !text || Buffer.from(text).toString('utf8') !== text || containsSensitiveText(text)) return fail();
  if (Buffer.byteLength(text) > PREFLIGHT_HTTP_LIMITS.outputBytes) fail('OUTPUT_LIMIT');
  return text;
};
const validId = (id: unknown, prefix: string): id is string => typeof id === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,64}$`).test(id);
const validateItem = (value: unknown, status: 'completed' | 'in_progress'): { id: string; text: string } => {
  const item = exact(value, ['id', 'type', 'role', 'status', 'content']);
  if (!validId(item.id, 'msg') || item.type !== 'message' || item.role !== 'assistant' || item.status !== status || !Array.isArray(item.content)) fail();
  const content = item.content as unknown[];
  if (status === 'in_progress') { if (content.length) fail(); return { id: item.id as string, text: '' }; }
  if (content.length !== 1) fail();
  const part = exact(content[0], ['type', 'text', 'annotations']);
  if (part.type !== 'output_text' || !Array.isArray(part.annotations) || part.annotations.length) fail();
  return { id: item.id as string, text: outputText(part.text) };
};
const validateResponse = (value: unknown, status: 'completed' | 'in_progress') => {
  const response = exact(value, ['id', 'object', 'status', 'model', 'output']);
  if (!validId(response.id, 'resp') || response.object !== 'response' || response.status !== status
    || response.model !== 'synthetic-investigator-v1' || !Array.isArray(response.output)) fail();
  const output = response.output as unknown[];
  if (status === 'in_progress') { if (output.length) fail(); return { id: response.id as string, itemId: '', text: '' }; }
  if (output.length !== 1) fail();
  const item = validateItem(output[0], 'completed');
  return { id: response.id as string, itemId: item.id, text: item.text };
};

/** A deliberately narrow, versioned local candidate; no provider compatibility is implied. */
class CandidateSseDecoder {
  private pending = '';
  private frame: string[] = [];
  private frameBytes = 0;
  private frameCount = 0;
  private sequence = 0;
  private phase: 'created' | 'item' | 'delta' | 'itemDone' | 'completed' | 'end' = 'created';
  private responseId = '';
  private itemId = '';
  private text = '';
  private deltas = 0;

  feed(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) !== -1) {
      const rawLine = this.pending.slice(0, end + 1);
      this.pending = this.pending.slice(end + 1);
      this.frameBytes += Buffer.byteLength(rawLine);
      if (this.frameBytes > PREFLIGHT_HTTP_LIMITS.frameBytes) fail('FRAME_LIMIT');
      const line = rawLine.slice(0, -1).replace(/\r$/, '');
      if (line.includes('\r') || line.includes('\0')) fail();
      if (!line) {
        if (++this.frameCount > PREFLIGHT_HTTP_LIMITS.frames) fail('FRAME_LIMIT');
        this.acceptFrame(); this.frame = []; this.frameBytes = 0;
      } else this.frame.push(line);
    }
    if (this.frameBytes + Buffer.byteLength(this.pending) > PREFLIGHT_HTTP_LIMITS.frameBytes) fail('FRAME_LIMIT');
  }
  finish(): string {
    if (this.pending || this.frame.length || this.frameBytes || this.phase !== 'end') fail();
    return outputText(this.text);
  }
  private acceptFrame(): void {
    let eventName: string | null = null;
    const data: string[] = [];
    for (const line of this.frame) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':'); if (colon === -1) fail();
      const name = line.slice(0, colon); const value = line.slice(colon + 1).replace(/^ /, '');
      if (name === 'event') { if (eventName !== null) fail(); eventName = value; }
      else if (name === 'data') data.push(value);
      else fail();
    }
    if (eventName === null && data.length === 0) return;
    if (this.phase === 'end' || eventName === null || !data.length) fail();
    const event = parse(data.join('\n'));
    if (!event || event.type !== eventName || event.sequence_number !== this.sequence++) fail();
    if (this.phase === 'created') {
      exact(event, ['type', 'sequence_number', 'response']);
      if (eventName !== 'response.created') fail();
      this.responseId = validateResponse(event.response, 'in_progress').id; this.phase = 'item'; return;
    }
    if (this.phase === 'completed') {
      exact(event, ['type', 'sequence_number', 'response']);
      if (eventName !== 'response.completed') fail();
      const response = validateResponse(event.response, 'completed');
      if (response.id !== this.responseId || response.itemId !== this.itemId || response.text !== this.text) fail();
      this.phase = 'end'; return;
    }
    if (this.phase === 'item' || this.phase === 'itemDone') {
      exact(event, ['type', 'sequence_number', 'response_id', 'output_index', 'item']);
      if (event.response_id !== this.responseId || event.output_index !== 0
        || eventName !== (this.phase === 'item' ? 'response.output_item.added' : 'response.output_item.done')) fail();
      const item = validateItem(event.item, this.phase === 'item' ? 'in_progress' : 'completed');
      if (this.phase === 'item') { this.itemId = item.id; this.phase = 'delta'; }
      else { if (item.id !== this.itemId || item.text !== this.text) fail(); this.phase = 'completed'; }
      return;
    }
    const isDelta = eventName === 'response.output_text.delta';
    if (!isDelta && eventName !== 'response.output_text.done') fail();
    exact(event, ['type', 'sequence_number', 'response_id', 'item_id', 'output_index', 'content_index', isDelta ? 'delta' : 'text']);
    if (event.response_id !== this.responseId || event.item_id !== this.itemId || event.output_index !== 0 || event.content_index !== 0) fail();
    if (isDelta) { this.text = outputText(this.text + outputText(event.delta)); this.deltas++; }
    else { if (!this.deltas || outputText(event.text) !== this.text) fail(); this.phase = 'itemDone'; }
  }
}

const validateHeaders = (response: PreflightHttpResponse, stream: boolean): void => {
  if (!response || !readonlyExactKeys(response, ['status', 'headers', 'body']) || !Array.isArray(response.headers)) fail();
  if (response.headers.length > PREFLIGHT_HTTP_LIMITS.headersCount) fail('HEADER_LIMIT');
  let bytes = 0; const headers = new Map<string, string>();
  for (const pair of response.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((v) => typeof v !== 'string' || /[\r\n\0]/.test(v))) fail();
    const [name, value] = pair;
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) fail();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > PREFLIGHT_HTTP_LIMITS.headersBytes) fail('HEADER_LIMIT');
    const key = name.toLowerCase(); if (headers.has(key)) fail(); headers.set(key, value);
  }
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) fail();
  if (response.status !== 200) fail(`HTTP_${response.status}`);
  if ([...headers.keys()].some((key) => !['content-type', 'content-encoding'].includes(key))) fail();
  const expected = stream ? 'text/event-stream' : 'application/json';
  if (!new RegExp(`^${expected}(?:;\\s*charset=utf-8)?$`, 'i').test(headers.get('content-type') ?? '')
    || (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity')) fail();
};

/** Never awaits an uncooperative iterator indefinitely, including its cleanup. */
export const decodeReadonlyModelPreflightResponse = async (
  response: PreflightHttpResponse, profileId: ReadonlyModelPreflightProfileId, signal: AbortSignal,
  options: PreflightDecodeOptions = {},
): Promise<ReadonlyModelPreflightDecodedResponse> => {
  if (!['responses-candidate-json-v1', 'responses-candidate-sse-v1'].includes(profileId)) fail('INVALID_PROFILE');
  const workMs = options.workTimeoutMs ?? PREFLIGHT_HTTP_LIMITS.workTimeoutMs;
  const cleanupMs = options.cleanupTimeoutMs ?? PREFLIGHT_HTTP_LIMITS.cleanupTimeoutMs;
  if (![workMs, cleanupMs].every((v) => Number.isInteger(v) && v > 0)
    || workMs > PREFLIGHT_HTTP_LIMITS.workTimeoutMs || cleanupMs > PREFLIGHT_HTTP_LIMITS.cleanupTimeoutMs
    || Object.keys(options).some((key) => !['workTimeoutMs', 'cleanupTimeoutMs'].includes(key))) fail();
  let iterator: AsyncIterator<Uint8Array> | null = null;
  let finished = false;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  // Always attach a rejection handler, even if validation fails before the first race.
  void aborted.catch(() => undefined);
  const abort = (): void => rejectAbort(new HarnessError('READONLY_MODEL_PREFLIGHT_CANCELLED'));
  signal.addEventListener('abort', abort, { once: true });
  const workTimer = setTimeout(() => rejectAbort(new HarnessError('READONLY_MODEL_PREFLIGHT_TIMEOUT')), workMs);
  const deadline = performance.now() + workMs;
  try {
    if (!response?.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail();
    iterator = response.body[Symbol.asyncIterator]();
    if (!iterator || typeof iterator.next !== 'function') fail();
    if (signal.aborted) fail('CANCELLED');
    const stream = profileId === 'responses-candidate-sse-v1'; validateHeaders(response, stream);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const sse = new CandidateSseDecoder(); const hash = createHash('sha256');
    let bytes = 0; let json = ''; let rawText = '';
    for (;;) {
      if (signal.aborted) fail('CANCELLED');
      if (performance.now() >= deadline) fail('TIMEOUT');
      const part = await Promise.race([Promise.resolve().then(() => iterator!.next()), aborted]);
      if (signal.aborted) fail('CANCELLED');
      if (performance.now() >= deadline) fail('TIMEOUT');
      if (!part || typeof part !== 'object' || typeof part.done !== 'boolean') fail();
      if (part.done) { finished = true; break; }
      if (!(part.value instanceof Uint8Array)) fail();
      bytes += part.value.byteLength;
      if (bytes > PREFLIGHT_HTTP_LIMITS.responseBytes) fail('RESPONSE_LIMIT');
      hash.update(part.value);
      let text: string; try { text = decoder.decode(part.value, { stream: true }); } catch { return fail(); }
      rawText += text;
      if (stream) sse.feed(text); else json += text;
    }
    let tail: string; try { tail = decoder.decode(); } catch { return fail(); }
    if (containsSensitiveText(rawText + tail)) fail();
    if (stream) sse.feed(tail); else json += tail;
    const text = stream ? sse.finish() : validateResponse(parse(json), 'completed').text;
    if (signal.aborted) fail('CANCELLED');
    if (performance.now() >= deadline) fail('TIMEOUT');
    return { text, responseHash: hash.digest('hex') };
  } catch (error) {
    if (error instanceof HarnessError && (['INVALID_RESPONSE', 'INVALID_PROFILE', 'RESPONSE_LIMIT', 'OUTPUT_LIMIT',
      'HEADER_LIMIT', 'FRAME_LIMIT', 'TIMEOUT', 'CANCELLED', 'LIFECYCLE_UNSAFE'].some((suffix) => error.code === `READONLY_MODEL_PREFLIGHT_${suffix}`)
      || /^READONLY_MODEL_PREFLIGHT_HTTP_[1-5]\d{2}$/.test(error.code))) throw error;
    return fail();
  } finally {
    clearTimeout(workTimer); signal.removeEventListener('abort', abort);
    if (iterator && !finished) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanupDeadline = performance.now() + cleanupMs;
      try {
        if (typeof iterator.return !== 'function') fail('LIFECYCLE_UNSAFE');
        const result = await Promise.race([Promise.resolve().then(() => iterator!.return!()),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HarnessError('READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE')), cleanupMs); })]);
        if (result?.done !== true || performance.now() >= cleanupDeadline) fail('LIFECYCLE_UNSAFE');
      } catch { fail('LIFECYCLE_UNSAFE'); } finally { clearTimeout(timer); }
    }
  }
};

/** Synthetic bytes only. This helper does not open a socket or read configuration. */
export const buildReadonlyModelPreflightFakeHttpResponse = (body: string): PreflightHttpResponse => {
  const request = assertReadonlyModelPreflightRequestBody(body);
  const text = buildReadonlyModelPreflightFakeReport(body);
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_synthetic', object: 'response', status: 'completed', model: 'synthetic-investigator-v1', output: [item] };
  const events = [
    { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', sequence_number: 1, response_id: response.id, output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', sequence_number: 2, response_id: response.id, item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', sequence_number: 3, response_id: response.id, item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', sequence_number: 4, response_id: response.id, output_index: 0, item },
    { type: 'response.completed', sequence_number: 5, response },
  ];
  const raw = request.stream ? events.map((event) => `event: ${event.type}\ndata: ${canonicalReadonlyJson(event)}\n\n`).join('') : canonicalReadonlyJson(response);
  const bytes = Buffer.from(raw);
  return { status: 200, headers: [['Content-Type', request.stream ? 'text/event-stream' : 'application/json']],
    body: { async *[Symbol.asyncIterator]() { for (let index = 0; index < bytes.length; index += 97) yield bytes.subarray(index, index + 97); } } };
};
