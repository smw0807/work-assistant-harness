import { createHash } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { HarnessError } from '../domain/errors.js';
import { copyReadonlyRelayReceptionDiagnostic, type ReadonlyRelayReceptionDiagnostic } from './readonly-relay-reception-diagnostics.js';

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
  const lines = /[^\r\n]*(?:\r\n|\r|\n|$)/gu;
  let frameBytes = 0; let frames = 0; let dataFrames = 0; let data: string[] = [];
  for (;;) {
    const rawLine = lines.exec(text)?.[0];
    if (!rawLine) break;
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

const validateHeaders = (response: Response, reject: (suffix: string) => never = fail): void => {
  if (response.status !== 200 || !response.body) reject('INVALID_HTTP');
  const pairs = [...response.headers.entries()];
  if (pairs.length > READONLY_RELAY_RESPONSE_LIMITS.headers
    || pairs.reduce((bytes, [key, value]) => bytes + Buffer.byteLength(key) + Buffer.byteLength(value) + 4, 0) > READONLY_RELAY_RESPONSE_LIMITS.headerBytes) reject('HEADER_LIMIT');
  if (response.headers.has('location') || response.headers.has('retry-after')) reject('INVALID_HTTP');
  const mime = response.headers.get('content-type'); const encoding = response.headers.get('content-encoding');
  if (mime !== null && !/^text\/event-stream(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(mime)) reject('INVALID_HTTP');
  if (encoding !== null && !/^identity$/iu.test(encoding.trim())) reject('INVALID_HTTP');
};

export interface ReadonlyRelayReceptionOptions {
  responseBytes?: 262144 | 1048576 | 2097152 | 4194304;
  observeDiagnostic?: (snapshot: ReadonlyRelayReceptionDiagnostic) => void;
}
const responseBudgets = [262144, 1048576, 2097152, 4194304] as const;
const terminationFor = (suffix: string): ReadonlyRelayReceptionDiagnostic['termination'] => {
  const known: Readonly<Record<string, ReadonlyRelayReceptionDiagnostic['termination']>> = {
    RESPONSE_LIMIT: 'response-limit', FRAME_LIMIT: 'frame-limit', HEADER_LIMIT: 'header-limit', INVALID_HTTP: 'invalid-http',
    INVALID_UTF8: 'invalid-utf8', INVALID_SSE: 'invalid-sse', INVALID_JSON: 'invalid-json',
    CREDENTIAL_REFLECTION: 'credential-reflection', CREDENTIAL_REFLECTION_LIMIT: 'reflection-state-limit',
    CANCELLED: 'cancelled', TIMEOUT: 'timeout', LIFECYCLE_UNSAFE: 'cleanup-uncertain',
    INVALID_CREDENTIAL: 'invalid-credential', INVALID_OPTIONS: 'invalid-options',
  };
  return known[suffix] ?? 'invalid-response';
};
const failedLimitFor = (termination: ReadonlyRelayReceptionDiagnostic['termination']): ReadonlyRelayReceptionDiagnostic['failedLimit'] =>
  termination === 'response-limit' ? 'response-bytes' : termination === 'frame-limit' ? 'frame'
    : termination === 'header-limit' ? 'headers' : termination === 'reflection-state-limit' ? 'credential-prefix-states' : 'none';

/** Byte-only framing observation cannot reject input or change the later SSE validator's ordering. */
const createWireCounter = () => {
  let completedFrames = 0; let frameBytes = 0; let maxFrameBytes = 0; let lineBytes = 0; let pendingCr = false;
  let probeBom = true; let prefix: number[] = [];
  const finishLine = (): void => {
    if (lineBytes === 0) { completedFrames++; frameBytes = 0; }
    lineBytes = 0;
  };
  const byte = (value: number): void => {
    if (pendingCr) {
      pendingCr = false;
      if (value === 10) { frameBytes++; maxFrameBytes = Math.max(maxFrameBytes, frameBytes); finishLine(); return; }
      finishLine();
    }
    frameBytes++; maxFrameBytes = Math.max(maxFrameBytes, frameBytes);
    if (value === 13) pendingCr = true;
    else if (value === 10) finishLine();
    else lineBytes++;
  };
  return {
    feed: (chunk: Uint8Array, maximum: number): void => {
      for (let index = 0; index < maximum; index++) {
        const value = chunk[index]!;
        if (!probeBom) { byte(value); continue; }
        prefix.push(value);
        if (prefix.every((part, index) => part === [239, 187, 191][index])) {
          if (prefix.length === 3) { probeBom = false; prefix = []; }
          continue;
        }
        probeBom = false; prefix.forEach(byte); prefix = [];
      }
    },
    finish: (): void => {
      prefix.forEach(byte); prefix = []; probeBom = false;
      if (pendingCr) { pendingCr = false; finishLine(); }
    },
    snapshot: () => ({ completedFrames, maxFrameBytes: Math.max(maxFrameBytes, frameBytes + prefix.length), partialFrameBytes: frameBytes + prefix.length }),
  };
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
  credential: { accessToken: string; accountId: string }, options?: ReadonlyRelayReceptionOptions): Promise<{ body: Buffer; responseHash: string }> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null; let eof = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: () => void = () => {};
  let subscribed = false;
  let responseBytes: number = READONLY_RELAY_RESPONSE_LIMITS.responseBytes;
  let observer: ReadonlyRelayReceptionOptions['observeDiagnostic'];
  let receivedBytes = 0; let bufferedBytes = 0; let inspectedBytes = 0; let chunks = 0; let maxChunkBytes = 0;
  let termination: ReadonlyRelayReceptionDiagnostic['termination'] = 'invalid-response';
  let failedLimit: ReadonlyRelayReceptionDiagnostic['failedLimit'] = 'none';
  let receptionFinished = false;
  let wire: ReturnType<typeof createWireCounter> | null = null;
  let interruption: RelayProtocolError | null = null;
  let rejectPending: ((error: RelayProtocolError) => void) | null = null;
  const rejectCurrent: (suffix: string) => never = (suffix) => {
    termination = terminationFor(suffix); failedLimit = failedLimitFor(termination); return fail(suffix);
  };
  const interruptWith = (suffix: 'CANCELLED' | 'TIMEOUT'): void => {
    if (interruption) return;
    interruption = new RelayProtocolError(`READONLY_RELAY_${suffix}`);
    if (!receptionFinished) termination = terminationFor(suffix);
    rejectPending?.(interruption);
  };
  const waitFor = <T>(operation: Promise<T>): Promise<T> => {
    if (interruption) { void operation.catch(() => {}); return Promise.reject(interruption); }
    return new Promise<T>((resolve, reject) => {
      let active = true;
      const cancel = (error: RelayProtocolError): void => {
        if (!active) return; active = false;
        if (rejectPending === cancel) rejectPending = null;
        reject(error);
      };
      // Only one read or yield can be pending. A shared never-settled race promise would retain one handler per chunk.
      rejectPending = cancel;
      operation.then((value) => {
        if (!active) return; active = false;
        if (rejectPending === cancel) rejectPending = null;
        resolve(value);
      }, (error: unknown) => {
        if (!active) return; active = false;
        if (rejectPending === cancel) rejectPending = null;
        reject(error);
      });
      if (interruption) cancel(interruption);
    });
  };
  try {
    if (options !== undefined) {
      try {
        if (!options || typeof options !== 'object' || Array.isArray(options)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) rejectCurrent('INVALID_OPTIONS');
        const keys = Reflect.ownKeys(options);
        if (keys.some((key) => !['responseBytes', 'observeDiagnostic'].includes(key as string))) rejectCurrent('INVALID_OPTIONS');
        const fields: Record<string, unknown> = Object.create(null);
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(options, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) rejectCurrent('INVALID_OPTIONS');
          fields[key as string] = descriptor.value;
        }
        if (Object.hasOwn(fields, 'observeDiagnostic')) {
          if (typeof fields.observeDiagnostic !== 'function') rejectCurrent('INVALID_OPTIONS');
          observer = fields.observeDiagnostic as ReadonlyRelayReceptionOptions['observeDiagnostic'];
        }
        if (Object.hasOwn(fields, 'responseBytes')) {
          if (!(responseBudgets as readonly unknown[]).includes(fields.responseBytes)) rejectCurrent('INVALID_OPTIONS');
          responseBytes = fields.responseBytes as number;
        }
      } catch { rejectCurrent('INVALID_OPTIONS'); }
    }
    wire = observer ? createWireCounter() : null;
    if (!(response instanceof Response) || !(signal instanceof AbortSignal) || !response.body) rejectCurrent('INVALID_HTTP');
    reader = response.body.getReader();
    let credentials: readonly string[];
    try { credentials = credentialStrings(credential); } catch (error) { termination = 'invalid-credential'; throw error; }
    validateHeaders(response, rejectCurrent);
    if (signal.aborted) rejectCurrent('CANCELLED');
    interrupt = () => interruptWith('CANCELLED');
    timer = setTimeout(() => interruptWith('TIMEOUT'), READONLY_RELAY_RESPONSE_LIMITS.workTimeoutMs);
    signal.addEventListener('abort', interrupt, { once: true });
    subscribed = true;
    const storage = Buffer.alloc(responseBytes);
    for (;;) {
      const next = await waitFor(reader.read());
      if (signal.aborted) rejectCurrent('CANCELLED');
      if (next.done) {
        eof = true;
        try { wire?.finish(); } catch { wire = null; observer = undefined; }
        break;
      }
      if (!(next.value instanceof Uint8Array)) rejectCurrent('INVALID_RESPONSE');
      const size = next.value.byteLength; receivedBytes += size; chunks++; maxChunkBytes = Math.max(maxChunkBytes, size);
      if (wire) {
        try {
          const inspected = Math.min(size, responseBytes - inspectedBytes);
          wire.feed(next.value, inspected); inspectedBytes += inspected;
        } catch { wire = null; observer = undefined; }
      }
      if (receivedBytes > responseBytes) rejectCurrent('RESPONSE_LIMIT');
      storage.set(next.value, bufferedBytes); bufferedBytes += size;
      if (chunks % 128 === 0) await waitFor(yieldImmediate());
    }
    const body = storage.subarray(0, bufferedBytes);
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { return rejectCurrent('INVALID_UTF8'); }
    try { assertNoReflection(raw, credentials); inspectSse(raw, credentials); }
    catch (error) {
      if (isLocalError(error)) {
        termination = terminationFor(error.code.slice('READONLY_RELAY_'.length)); failedLimit = failedLimitFor(termination);
      }
      throw error;
    }
    termination = 'eof'; receptionFinished = true;
    return { body, responseHash: createHash('sha256').update(body).digest('hex') };
  } catch (error) {
    receptionFinished = true;
    if (reader && !eof) {
      try { await cancelReader(reader); } catch (cleanup) { termination = 'cleanup-uncertain'; throw cleanup; }
    }
    throw isLocalError(error) ? error : new RelayProtocolError('READONLY_RELAY_INVALID_RESPONSE');
  } finally {
    if (timer) clearTimeout(timer);
    try { if (subscribed) signal.removeEventListener('abort', interrupt); } catch { /* No untrusted cleanup message escapes. */ }
    try { reader?.releaseLock(); } catch { /* A failed cancellation is already reported as uncertain. */ }
    try {
      const counters = wire?.snapshot() ?? { completedFrames: 0, maxFrameBytes: 0, partialFrameBytes: 0 };
      const snapshot = copyReadonlyRelayReceptionDiagnostic({ receivedBytes, bufferedBytes, inspectedBytes, chunks, maxChunkBytes,
        ...counters, eof, termination, failedLimit });
      if (snapshot && observer) void Promise.resolve(observer(snapshot)).catch(() => {});
    } catch { /* Diagnostic delivery cannot change the original collector result. */ }
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
