import { createHash } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';

export const READONLY_RELAY_RESPONSE_LIMITS = Object.freeze({ responseBytes: 256 * 1024, frameBytes: 64 * 1024,
  frames: 2048, jsonDepth: 16, headers: 64, headerBytes: 16 * 1024, outputBytes: 16 * 1024,
  cliBytes: 128 * 1024, workTimeoutMs: 55_000, cleanupTimeoutMs: 5_000 });
const localErrors = new WeakSet<object>();
class RelayProtocolError extends HarnessError {
  constructor(code: string) { super(code); localErrors.add(this); }
}
const isLocalError = (error: unknown): error is RelayProtocolError =>
  error !== null && typeof error === 'object' && localErrors.has(error);
const fail: (suffix: string) => never = (suffix) => { throw new RelayProtocolError(`READONLY_RELAY_${suffix}`); };
const validUnicode = (value: string): boolean => Buffer.from(value).toString('utf8') === value;

/** Syntax and decoded strings only; provider event names, metadata and sequence values have no meaning here. */
const parseJson = (raw: string, maximum: number, inspectString?: (value: string) => void): unknown => {
  if (Buffer.byteLength(raw) > maximum || !validUnicode(raw)) fail('INVALID_JSON');
  let offset = 0;
  const whitespace = (): void => { while (offset < raw.length && /[\t\n\r ]/u.test(raw[offset]!)) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      const character = raw[offset++];
      if (character === '\\') { offset++; continue; }
      if (character === '"') {
        const decoded = JSON.parse(raw.slice(start, offset)) as string;
        if (!validUnicode(decoded)) fail('INVALID_JSON');
        inspectString?.(decoded);
        return decoded;
      }
    }
    return fail('INVALID_JSON');
  };
  const value = (depth: number): void => {
    if (depth > READONLY_RELAY_RESPONSE_LIMITS.jsonDepth) fail('INVALID_JSON');
    whitespace();
    if (raw[offset] === '"') { string(); return; }
    if (raw[offset] === '{') {
      offset++; whitespace(); const keys = new Set<string>();
      if (raw[offset] === '}') { offset++; return; }
      while (offset < raw.length) {
        whitespace(); if (raw[offset] !== '"') fail('INVALID_JSON');
        const key = string(); if (keys.has(key)) fail('INVALID_JSON'); keys.add(key);
        whitespace(); if (raw[offset++] !== ':') fail('INVALID_JSON'); value(depth + 1); whitespace();
        const ending = raw[offset++]; if (ending === '}') return; if (ending !== ',') fail('INVALID_JSON');
      }
      fail('INVALID_JSON');
    }
    if (raw[offset] === '[') {
      offset++; whitespace(); if (raw[offset] === ']') { offset++; return; }
      while (offset < raw.length) {
        value(depth + 1); whitespace(); const ending = raw[offset++]; if (ending === ']') return; if (ending !== ',') fail('INVALID_JSON');
      }
      fail('INVALID_JSON');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(raw.slice(offset));
    if (!token) fail('INVALID_JSON');
    if (!['true', 'false', 'null'].includes(token[0]) && !Number.isFinite(Number(token[0]))) fail('INVALID_JSON');
    offset += token[0].length;
  };
  try { value(0); whitespace(); if (offset !== raw.length) fail('INVALID_JSON'); return JSON.parse(raw) as unknown; }
  catch (error) { if (isLocalError(error)) throw error; return fail('INVALID_JSON'); }
};

const credentialStrings = (value: { accessToken: string; accountId: string }): readonly string[] => {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_CREDENTIAL');
    return ['accessToken', 'accountId'].map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
        || descriptor.value.length < 12 || descriptor.value.length > 16384 || !validUnicode(descriptor.value)) fail('INVALID_CREDENTIAL');
      return descriptor.value as string;
    });
  } catch { return fail('INVALID_CREDENTIAL'); }
};
const assertNoReflection = (value: string, credentials: readonly string[]): void => {
  if (credentials.some((credential) => value.includes(credential))) fail('CREDENTIAL_REFLECTION');
};
const reflectionScanner = (credentials: readonly string[]): ((value: string) => void) => {
  const tracked = credentials.map((secret) => {
    const prefix = Array<number>(secret.length).fill(0);
    for (let index = 1, length = 0; index < secret.length; index++) {
      while (length > 0 && secret[index] !== secret[length]) length = prefix[length - 1]!;
      if (secret[index] === secret[length]) length++;
      prefix[index] = length;
    }
    return { secret, prefix, positions: new Set<number>() };
  });
  const remember = (positions: Set<number>, length: number): void => {
    positions.add(length);
    if (tracked.reduce((total, entry) => total + entry.positions.size, 0) > 64) fail('CREDENTIAL_REFLECTION_LIMIT');
  };
  return (value) => {
    assertNoReflection(value, credentials);
    for (const { secret, prefix, positions } of tracked) {
      // Unrelated strings may intervene between fragments. A partial match advances only over a whole string prefix.
      for (const position of [...positions]) {
        let length = 0;
        while (length < value.length && position + length < secret.length && value[length] === secret[position + length]) length++;
        if (position + length === secret.length) fail('CREDENTIAL_REFLECTION');
        if (length > 0 && length === value.length) remember(positions, position + length);
      }
      let length = 0;
      for (let index = 0; index < value.length; index++) {
        while (length > 0 && value[index] !== secret[length]) length = prefix[length - 1]!;
        if (value[index] === secret[length]) length++;
        if (length === secret.length) fail('CREDENTIAL_REFLECTION');
      }
      while (length > 0) { remember(positions, length); length = prefix[length - 1]!; }
    }
  };
};

/** Final investigation JSON gets the same exact-credential and ordered-fragment guard before it can be stored. */
export const assertReadonlyRelayCredentialText = (text: string, credential: { accessToken: string; accountId: string }): void => {
  if (typeof text !== 'string' || !validUnicode(text) || Buffer.byteLength(text) > READONLY_RELAY_RESPONSE_LIMITS.outputBytes) fail('OUTPUT_LIMIT');
  const credentials = credentialStrings(credential);
  assertNoReflection(text, credentials);
  parseJson(text, READONLY_RELAY_RESPONSE_LIMITS.outputBytes, reflectionScanner(credentials));
};

/** Every data frame is bounded JSON or the exact opaque [DONE] sentinel; no completion claim is inferred. */
const inspectSse = (raw: string, credentials: readonly string[]): void => {
  const inspectString = reflectionScanner(credentials);
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? [];
  if (lines.at(-1) === '') lines.pop();
  let frameBytes = 0; let frames = 0; let dataFrames = 0; let data: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/(?:\r\n|\r|\n)$/u, '');
    frameBytes += Buffer.byteLength(rawLine);
    if (frameBytes > READONLY_RELAY_RESPONSE_LIMITS.frameBytes) fail('FRAME_LIMIT');
    if (line === '') {
      if (++frames > READONLY_RELAY_RESPONSE_LIMITS.frames) fail('FRAME_LIMIT');
      if (data.length) {
        const payload = data.join('\n'); dataFrames++;
        if (payload !== '[DONE]') parseJson(payload, READONLY_RELAY_RESPONSE_LIMITS.frameBytes, inspectString);
      }
      frameBytes = 0; data = []; continue;
    }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let content = separator < 0 ? '' : line.slice(separator + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
  }
  if (frameBytes !== 0 || data.length || dataFrames === 0) fail('INVALID_SSE');
};

const validateHeaders = (response: Response): void => {
  if (response.status !== 200 || !response.body) fail('INVALID_HTTP');
  const pairs = [...response.headers.entries()];
  if (pairs.length > READONLY_RELAY_RESPONSE_LIMITS.headers
    || pairs.reduce((bytes, [key, value]) => bytes + Buffer.byteLength(key) + Buffer.byteLength(value) + 4, 0) > READONLY_RELAY_RESPONSE_LIMITS.headerBytes) fail('HEADER_LIMIT');
  if (response.headers.has('location') || response.headers.has('retry-after')) fail('INVALID_HTTP');
  const mime = response.headers.get('content-type'); const encoding = response.headers.get('content-encoding');
  if (mime !== null && !/^text\/event-stream(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(mime)) fail('INVALID_HTTP');
  if (encoding !== null && !/^identity$/iu.test(encoding.trim())) fail('INVALID_HTTP');
};

const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(() => reader.cancel()), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RelayProtocolError('READONLY_RELAY_LIFECYCLE_UNSAFE')), READONLY_RELAY_RESPONSE_LIMITS.cleanupTimeoutMs);
    })]);
  } catch { fail('LIFECYCLE_UNSAFE'); }
  finally { if (timer) clearTimeout(timer); }
};

/** Nothing is returned to the child until EOF, framing and credential checks all finish successfully. */
export const collectReadonlyRelayResponse = async (response: Response, signal: AbortSignal,
  credential: { accessToken: string; accountId: string }): Promise<{ body: Buffer; responseHash: string }> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null; let eof = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: () => void = () => {};
  let subscribed = false;
  try {
    if (!(response instanceof Response) || !(signal instanceof AbortSignal) || !response.body) fail('INVALID_HTTP');
    reader = response.body.getReader();
    const credentials = credentialStrings(credential);
    validateHeaders(response);
    if (signal.aborted) fail('CANCELLED');
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new RelayProtocolError('READONLY_RELAY_CANCELLED'));
      timer = setTimeout(() => reject(new RelayProtocolError('READONLY_RELAY_TIMEOUT')), READONLY_RELAY_RESPONSE_LIMITS.workTimeoutMs);
    });
    signal.addEventListener('abort', interrupt, { once: true });
    subscribed = true;
    const chunks: Buffer[] = []; let bytes = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (signal.aborted) fail('CANCELLED');
      if (next.done) { eof = true; break; }
      if (!(next.value instanceof Uint8Array)) fail('INVALID_RESPONSE');
      bytes += next.value.byteLength;
      if (bytes > READONLY_RELAY_RESPONSE_LIMITS.responseBytes) fail('RESPONSE_LIMIT');
      chunks.push(Buffer.from(next.value));
    }
    const body = Buffer.concat(chunks);
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { return fail('INVALID_UTF8'); }
    assertNoReflection(raw, credentials); inspectSse(raw, credentials);
    return { body, responseHash: createHash('sha256').update(body).digest('hex') };
  } catch (error) {
    if (reader && !eof) await cancelReader(reader);
    throw isLocalError(error) ? error : new RelayProtocolError('READONLY_RELAY_INVALID_RESPONSE');
  } finally {
    if (timer) clearTimeout(timer);
    try { if (subscribed) signal.removeEventListener('abort', interrupt); } catch { /* No untrusted cleanup message escapes. */ }
    try { reader?.releaseLock(); } catch { /* A failed cancellation is already reported as uncertain. */ }
  }
};

const warning = 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
/** The pinned CLI may emit reasoning; it grants no tool permission and never becomes the returned answer. */
export const parseReadonlyRelayCodexOutput = (output: string, maxResponseBytes = 16384): string => {
  if (typeof output !== 'string' || !validUnicode(output) || Buffer.byteLength(output) > READONLY_RELAY_RESPONSE_LIMITS.cliBytes) fail('OUTPUT_LIMIT');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > READONLY_RELAY_RESPONSE_LIMITS.outputBytes) fail('OUTPUT_LIMIT');
  let state: 'initial' | 'thread' | 'turn' | 'message' | 'completed' = 'initial';
  let finalText: string | null = null; let warned = false; let assistantStarted = false; let reasoningOpen = false;
  for (const line of output.split('\n').filter(Boolean)) {
    const value = parseJson(line, READONLY_RELAY_RESPONSE_LIMITS.cliBytes);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CLI_OUTPUT');
    const event = value as { type?: unknown; item?: { type?: unknown; text?: unknown; message?: unknown } };
    if (event.type === 'thread.started' && state === 'initial') { state = 'thread'; continue; }
    if (event.type === 'turn.started' && state === 'thread') { state = 'turn'; continue; }
    if (event.type === 'item.completed' && event.item?.type === 'error' && !warned
      && ['thread', 'turn'].includes(state) && event.item.message === warning) { warned = true; continue; }
    if (state === 'turn' && event.item?.type === 'reasoning' && !assistantStarted) {
      if (event.item.text !== undefined && typeof event.item.text !== 'string') fail('INVALID_CLI_OUTPUT');
      if (event.type === 'item.started' && !reasoningOpen) { reasoningOpen = true; continue; }
      if (event.type === 'item.completed') { reasoningOpen = false; continue; }
    }
    if (state === 'turn' && !reasoningOpen && event.item?.type === 'agent_message') {
      if (event.type === 'item.started' && !assistantStarted) {
        if (event.item.text !== undefined && typeof event.item.text !== 'string') fail('INVALID_CLI_OUTPUT');
        assistantStarted = true; continue;
      }
      if (event.type === 'item.completed' && typeof event.item.text === 'string' && event.item.text.length > 0) {
        if (Buffer.byteLength(event.item.text) > maxResponseBytes) fail('OUTPUT_LIMIT');
        finalText = event.item.text; state = 'message'; continue;
      }
    }
    if (event.type === 'turn.completed' && state === 'message') { state = 'completed'; continue; }
    fail('INVALID_CLI_OUTPUT');
  }
  if (state !== 'completed' || finalText === null) fail('INVALID_CLI_OUTPUT');
  parseJson(finalText, maxResponseBytes);
  return finalText;
};
