import { HarnessError } from '../domain/errors.js';
import { READONLY_TRANSPORT_RESPONSE_VERSION, type ReadonlyTransportProfileId } from '../domain/readonly-transport.js';
import { canonicalReadonlyJson, readonlyExactKeys, READONLY_LIMITS } from './readonly-investigation-policy.js';
import { containsSensitiveText } from './redaction.js';

export const READONLY_TRANSPORT_REQUEST_BYTES = 256 * 1024;
export const READONLY_TRANSPORT_RESPONSE_BYTES = 256 * 1024;
const reject = (code = 'READONLY_TRANSPORT_INVALID_RESPONSE'): never => { throw new HarnessError(code); };

/** Duplicate decoded keys are checked before JSON.parse can discard them. */
export const parseReadonlyTransportJson = (raw: string, maximum = READONLY_TRANSPORT_RESPONSE_BYTES): unknown => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum) reject('READONLY_TRANSPORT_OUTPUT_LIMIT');
  let offset = 0;
  const whitespace = (): void => { while (offset < raw.length && /[\t\n\r ]/u.test(raw[offset]!)) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      const character = raw[offset++];
      if (character === '\\') { offset++; continue; }
      if (character === '"') {
        const text = JSON.parse(raw.slice(start, offset)) as string;
        if (Buffer.from(text).toString('utf8') !== text) reject();
        return text;
      }
    }
    return reject();
  };
  const value = (depth: number): void => {
    if (depth > 16) reject();
    whitespace();
    if (raw[offset] === '"') { string(); return; }
    if (raw[offset] === '{') {
      offset++; whitespace(); const keys = new Set<string>();
      if (raw[offset] === '}') { offset++; return; }
      while (offset < raw.length) {
        whitespace(); if (raw[offset] !== '"') reject();
        const key = string(); if (keys.has(key)) reject('READONLY_TRANSPORT_DUPLICATE_KEY'); keys.add(key);
        whitespace(); if (raw[offset++] !== ':') reject(); value(depth + 1); whitespace();
        const end = raw[offset++]; if (end === '}') return; if (end !== ',') reject();
      }
      reject();
    }
    if (raw[offset] === '[') {
      offset++; whitespace(); if (raw[offset] === ']') { offset++; return; }
      while (offset < raw.length) {
        value(depth + 1); whitespace(); const end = raw[offset++]; if (end === ']') return; if (end !== ',') reject();
      }
      reject();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(raw.slice(offset));
    if (!token) return reject(); offset += token[0].length;
  };
  try {
    value(0); whitespace(); if (offset !== raw.length) reject();
    const parsed: unknown = JSON.parse(raw);
    if (containsSensitiveText(raw) || containsSensitiveText(canonicalReadonlyJson(parsed))) reject();
    return parsed;
  } catch (error) { if (error instanceof HarnessError) throw error; return reject(); }
};

const assertProfile = (profileId: ReadonlyTransportProfileId): void => {
  if (!['synthetic-json-v1', 'synthetic-stream-v1'].includes(profileId)) reject('READONLY_TRANSPORT_INVALID_PROFILE');
};
const boundedFinal = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || Buffer.from(value).toString('utf8') !== value) return reject();
  if (Buffer.byteLength(value) > READONLY_LIMITS.outputBytes) reject('READONLY_TRANSPORT_OUTPUT_LIMIT');
  return value;
};

/** Local JSON/NDJSON fixtures; this is deliberately not an external provider protocol. */
export const decodeReadonlyTransportResponse = (raw: Uint8Array, profileId: ReadonlyTransportProfileId): string => {
  assertProfile(profileId);
  if (!(raw instanceof Uint8Array) || raw.byteLength > READONLY_TRANSPORT_RESPONSE_BYTES) reject('READONLY_TRANSPORT_OUTPUT_LIMIT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { return reject(); }
  if (profileId === 'synthetic-json-v1') {
    const envelope = parseReadonlyTransportJson(text) as Record<string, unknown>;
    if (!readonlyExactKeys(envelope, ['version', 'profileId', 'model', 'status', 'output'])
      || envelope.version !== READONLY_TRANSPORT_RESPONSE_VERSION || envelope.profileId !== profileId
      || envelope.model !== 'synthetic-investigator-v1' || envelope.status !== 'completed'
      || !readonlyExactKeys(envelope.output, ['type', 'text'])) reject();
    const output = envelope.output as { type: unknown; text: unknown };
    if (output.type !== 'output_text') reject();
    return boundedFinal(output.text);
  }
  if (!text.endsWith('\n') || text.includes('\r')) reject();
  const events = text.slice(0, -1).split('\n');
  if (events.length < 3 || events.length > 258) reject();
  let output = ''; let chunks = 0;
  for (const [index, rawEvent] of events.entries()) {
    const event = parseReadonlyTransportJson(rawEvent) as Record<string, unknown>;
    if (index === 0) {
      if (!readonlyExactKeys(event, ['version', 'profileId', 'model', 'type'])
        || event.version !== READONLY_TRANSPORT_RESPONSE_VERSION || event.profileId !== profileId
        || event.model !== 'synthetic-investigator-v1' || event.type !== 'response.started') reject();
    } else if (index === events.length - 1) {
      if (!readonlyExactKeys(event, ['type', 'chunks']) || event.type !== 'response.completed' || event.chunks !== chunks || chunks === 0) reject();
    } else {
      if (!readonlyExactKeys(event, ['type', 'sequence', 'text']) || event.type !== 'response.delta'
        || event.sequence !== chunks || typeof event.text !== 'string' || event.text.length === 0) reject();
      output = boundedFinal(output + event.text); chunks++;
    }
  }
  return boundedFinal(output);
};

export const encodeReadonlyTransportResponse = (finalJson: string, profileId: ReadonlyTransportProfileId): Uint8Array => {
  assertProfile(profileId); boundedFinal(finalJson);
  const metadata = { version: READONLY_TRANSPORT_RESPONSE_VERSION, profileId, model: 'synthetic-investigator-v1' };
  const text = profileId === 'synthetic-json-v1'
    ? canonicalReadonlyJson({ ...metadata, status: 'completed', output: { type: 'output_text', text: finalJson } })
    : [canonicalReadonlyJson({ ...metadata, type: 'response.started' }),
      canonicalReadonlyJson({ type: 'response.delta', sequence: 0, text: finalJson }),
      canonicalReadonlyJson({ type: 'response.completed', chunks: 1 })].join('\n') + '\n';
  if (Buffer.byteLength(text) > READONLY_TRANSPORT_RESPONSE_BYTES) reject('READONLY_TRANSPORT_OUTPUT_LIMIT');
  return Buffer.from(text);
};
