import { createHash } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyLiveDecodedResponse, ReadonlyLiveProfileId } from '../domain/readonly-live.js';
import { canonicalReadonlyJson, readonlyExactKeys } from './readonly-investigation-policy.js';
import { containsSensitiveText } from './redaction.js';
import { classifyReadonlyLiveSensitiveContent, classifyReadonlyLiveSensitiveAttribution, copyReadonlyLiveSensitiveDiagnostic,
  copyReadonlyLiveSensitiveAttribution, classifyReadonlyLiveSensitiveMatches, copyReadonlyLiveSensitiveMatches,
  type ReadonlyLiveSensitiveDiagnostic, type ReadonlyLiveSensitiveAttribution, type ReadonlyLiveSensitiveMatches } from './readonly-live-sensitive-diagnostics.js';
import { classifyReadonlyLiveSseEnvelope, copyReadonlyLiveSseEnvelopeDiagnostic,
  type ReadonlyLiveSseEnvelopeDiagnostic } from './readonly-live-sse-envelope-diagnostics.js';
import { classifyReadonlyLiveResponseEnvelope, copyReadonlyLiveResponseEnvelopeDiagnostic,
  type ReadonlyLiveResponseEnvelopeDiagnostic } from './readonly-live-response-envelope-diagnostics.js';
import { projectReadonlyLiveResponseExtensions } from './readonly-live-response-extensions.js';
import { copyReadonlyLiveMetadataDiagnostic, type ReadonlyLiveMetadataDiagnostic } from './readonly-live-metadata-diagnostics.js';

export interface ReadonlyLiveHttpResponse { status: number; headers: [string, string][]; body: AsyncIterable<Uint8Array> }
export interface ReadonlyLiveDecodeOptions { workTimeoutMs?: number; cleanupTimeoutMs?: number; profileId?: ReadonlyLiveProfileId }
export interface ReadonlyLiveJsonDiagnostic {
  origin: 'response' | 'sse';
  reason: 'syntax' | 'depth' | 'duplicate-key' | 'unicode' | 'sensitive-content' | 'canonicalization';
}
const jsonReasons: ReadonlyArray<ReadonlyLiveJsonDiagnostic['reason']> = ['syntax', 'depth', 'duplicate-key', 'unicode', 'sensitive-content', 'canonicalization'];
/** Read only fixed own data properties; diagnostics never carry parser messages, paths, keys or values. */
export const getReadonlyLiveJsonDiagnostic = (error: unknown): ReadonlyLiveJsonDiagnostic | null => {
  try {
    if (!error || typeof error !== 'object') return null;
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (!code || !Object.hasOwn(code, 'value') || !['READONLY_LIVE_INVALID_RESPONSE', 'READONLY_LIVE_INVALID_RESPONSE_JSON'].includes(code.value)) return null;
    const field = Object.getOwnPropertyDescriptor(error, 'jsonDiagnostic');
    if (!field || !Object.hasOwn(field, 'value') || !field.value || typeof field.value !== 'object' || Array.isArray(field.value)) return null;
    const keys = Reflect.ownKeys(field.value);
    if (keys.length !== 2 || !keys.includes('origin') || !keys.includes('reason')) return null;
    const origin = Object.getOwnPropertyDescriptor(field.value, 'origin');
    const reason = Object.getOwnPropertyDescriptor(field.value, 'reason');
    if (!origin || !reason || !Object.hasOwn(origin, 'value') || !Object.hasOwn(reason, 'value')
      || !['response', 'sse'].includes(origin.value) || !jsonReasons.includes(reason.value)) return null;
    return { origin: origin.value as ReadonlyLiveJsonDiagnostic['origin'], reason: reason.value as ReadonlyLiveJsonDiagnostic['reason'] };
  } catch { return null; }
};
export const getReadonlyLiveSensitiveDiagnostic = (error: unknown): ReadonlyLiveSensitiveDiagnostic | null => {
  if (getReadonlyLiveJsonDiagnostic(error)?.reason !== 'sensitive-content') return null;
  try {
    const field = Object.getOwnPropertyDescriptor(error, 'sensitiveDiagnostic');
    return field && Object.hasOwn(field, 'value') ? copyReadonlyLiveSensitiveDiagnostic(field.value) : null;
  } catch { return null; }
};
export const getReadonlyLiveSensitiveAttribution = (error: unknown): ReadonlyLiveSensitiveAttribution | null => {
  if (getReadonlyLiveJsonDiagnostic(error)?.reason !== 'sensitive-content') return null;
  try {
    const field = Object.getOwnPropertyDescriptor(error, 'attributionDiagnostic');
    return field && Object.hasOwn(field, 'value') ? copyReadonlyLiveSensitiveAttribution(field.value) : null;
  } catch { return null; }
};
export const getReadonlyLiveSensitiveMatches = (error: unknown): ReadonlyLiveSensitiveMatches | null => {
  if (getReadonlyLiveJsonDiagnostic(error)?.reason !== 'sensitive-content') return null;
  try {
    const field = Object.getOwnPropertyDescriptor(error, 'matchDiagnostics');
    return field && Object.hasOwn(field, 'value') ? copyReadonlyLiveSensitiveMatches(field.value) : null;
  } catch { return null; }
};
class ReadonlyLiveJsonError extends HarnessError {
  constructor(code: string, diagnostic: ReadonlyLiveJsonDiagnostic, sensitive: ReadonlyLiveSensitiveDiagnostic | null = null,
    attribution: ReadonlyLiveSensitiveAttribution | null = null, matches: ReadonlyLiveSensitiveMatches | null = null) {
    super(code);
    Object.defineProperty(this, 'jsonDiagnostic', { value: Object.freeze({ origin: diagnostic.origin, reason: diagnostic.reason }) });
    if (sensitive) Object.defineProperty(this, 'sensitiveDiagnostic', { value: Object.freeze({ ...sensitive }) });
    if (attribution) Object.defineProperty(this, 'attributionDiagnostic', { value: Object.freeze({ ...attribution }) });
    const copiedMatches = copyReadonlyLiveSensitiveMatches(matches);
    if (copiedMatches) {
      copiedMatches.entries.forEach(Object.freeze); Object.freeze(copiedMatches.entries); Object.freeze(copiedMatches);
      Object.defineProperty(this, 'matchDiagnostics', { value: copiedMatches });
    }
  }
}
const sseEvents = ['created', 'in-progress', 'completed', 'output-item', 'content-part', 'output-text', 'reasoning-summary', 'missing', 'other'] as const;
const sseReasons = ['event-type', 'event-name', 'sequence-missing', 'sequence-invalid', 'sequence-start', 'sequence-step',
  'envelope', 'identity', 'state', 'order', 'index', 'text-consistency', 'unsupported-event'] as const;
export interface ReadonlyLiveSseDiagnostic {
  event: typeof sseEvents[number]; reason: typeof sseReasons[number];
  sequence: 'missing' | 'invalid' | 'zero' | 'one' | 'later'; position: 'first' | 'later';
}
/** Fixed event classes and failure boundaries only; event values, IDs and sequence numbers never escape. */
export const getReadonlyLiveSseDiagnostic = (error: unknown): ReadonlyLiveSseDiagnostic | null => {
  try {
    if (!error || typeof error !== 'object') return null;
    const read = (value: object, key: string): unknown => {
      const field = Object.getOwnPropertyDescriptor(value, key); return field && Object.hasOwn(field, 'value') ? field.value : undefined;
    };
    if (read(error, 'code') !== 'READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT') return null;
    const value = read(error, 'sseDiagnostic');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 4 || keys.some((key) => !['event', 'reason', 'sequence', 'position'].includes(key as string))) return null;
    const event = read(value, 'event'); const reason = read(value, 'reason'); const sequence = read(value, 'sequence'); const position = read(value, 'position');
    if (!(sseEvents as readonly unknown[]).includes(event) || !(sseReasons as readonly unknown[]).includes(reason)
      || !['missing', 'invalid', 'zero', 'one', 'later'].includes(sequence as string) || !['first', 'later'].includes(position as string)) return null;
    return { event, reason, sequence, position } as ReadonlyLiveSseDiagnostic;
  } catch { return null; }
};
export const getReadonlyLiveSseEnvelopeDiagnostic = (error: unknown): ReadonlyLiveSseEnvelopeDiagnostic | null => {
  if (getReadonlyLiveSseDiagnostic(error)?.reason !== 'envelope') return null;
  try {
    const field = Object.getOwnPropertyDescriptor(error, 'sseEnvelopeDiagnostic');
    return field && Object.hasOwn(field, 'value') ? copyReadonlyLiveSseEnvelopeDiagnostic(field.value) : null;
  } catch { return null; }
};
const sseEventClass = (type: unknown): ReadonlyLiveSseDiagnostic['event'] => {
  if (type === undefined) return 'missing';
  if (type === 'response.created') return 'created';
  if (type === 'response.in_progress') return 'in-progress';
  if (type === 'response.completed') return 'completed';
  if (['response.output_item.added', 'response.output_item.done'].includes(type as string)) return 'output-item';
  if (['response.content_part.added', 'response.content_part.done'].includes(type as string)) return 'content-part';
  if (['response.output_text.delta', 'response.output_text.done'].includes(type as string)) return 'output-text';
  if (['response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done'].includes(type as string)) return 'reasoning-summary';
  return 'other';
};
class ReadonlyLiveSseError extends HarnessError {
  constructor(code: string, diagnostic: ReadonlyLiveSseDiagnostic, envelope: ReadonlyLiveSseEnvelopeDiagnostic | null = null) {
    super(code); Object.defineProperty(this, 'sseDiagnostic', { value: Object.freeze({ ...diagnostic }) });
    const copied = copyReadonlyLiveSseEnvelopeDiagnostic(envelope);
    if (copied) {
      copied.unexpected.forEach(Object.freeze); Object.freeze(copied.unexpected); Object.freeze(copied.missing); Object.freeze(copied);
      Object.defineProperty(this, 'sseEnvelopeDiagnostic', { value: copied });
    }
  }
}
const responseEvents = ['direct-response', 'created', 'in-progress', 'completed'] as const;
const responseReasons = ['envelope', 'object-marker', 'status', 'model', 'output-type', 'output-count',
  'duplicate-item-id', 'assistant-count', 'response-id', 'extension-key', 'extension-limit', 'extension-value',
  'extension-sensitive', 'extension-control'] as const;
export interface ReadonlyLiveResponseDiagnostic {
  event: typeof responseEvents[number]; reason: typeof responseReasons[number]; envelope: ReadonlyLiveResponseEnvelopeDiagnostic | null;
}
const copyResponseDiagnostic = (value: unknown): ReadonlyLiveResponseDiagnostic | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value); if (keys.length !== 3 || !['event', 'reason', 'envelope'].every((key) => keys.includes(key))) return null;
    const fields = ['event', 'reason', 'envelope'].map((key) => Object.getOwnPropertyDescriptor(value, key));
    if (fields.some((field) => !field || !Object.hasOwn(field, 'value') || !field.enumerable)) return null;
    const [event, reason, rawEnvelope] = fields.map((field) => field!.value);
    if (!(responseEvents as readonly unknown[]).includes(event) || !(responseReasons as readonly unknown[]).includes(reason)) return null;
    const envelope = rawEnvelope === null ? null : copyReadonlyLiveResponseEnvelopeDiagnostic(rawEnvelope);
    if ((rawEnvelope !== null && !envelope) || (reason !== 'envelope' && envelope !== null)) return null;
    return { event, reason, envelope };
  } catch { return null; }
};
/** Preserve only fixed response validation boundaries and bounded field classes. */
export const getReadonlyLiveResponseDiagnostic = (error: unknown): ReadonlyLiveResponseDiagnostic | null => {
  try {
    if (!error || typeof error !== 'object') return null;
    const code = Object.getOwnPropertyDescriptor(error, 'code'); const diagnostic = Object.getOwnPropertyDescriptor(error, 'responseDiagnostic');
    if (!code || !Object.hasOwn(code, 'value') || code.value !== 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS'
      || !diagnostic || !Object.hasOwn(diagnostic, 'value')) return null;
    return copyResponseDiagnostic(diagnostic.value);
  } catch { return null; }
};
const metadataDiagnostics = new WeakMap<object, ReadonlyLiveMetadataDiagnostic>();
/** Only the local metadata validator can attest the first boundary; transport errors cannot supply diagnostics. */
export const getReadonlyLiveMetadataDiagnostic = (error: unknown): ReadonlyLiveMetadataDiagnostic | null => {
  try {
    if (!error || typeof error !== 'object') return null;
    const snapshot = metadataDiagnostics.get(error);
    if (!snapshot) return null;
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    const diagnostic = Object.getOwnPropertyDescriptor(error, 'metadataDiagnostic');
    if (!code || !Object.hasOwn(code, 'value') || code.value !== 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_METADATA'
      || !diagnostic || !Object.hasOwn(diagnostic, 'value') || diagnostic.value !== snapshot) return null;
    return copyReadonlyLiveMetadataDiagnostic(snapshot);
  } catch { return null; }
};
class ReadonlyLiveResponseError extends HarnessError {
  constructor(code: string, diagnostic: ReadonlyLiveResponseDiagnostic) {
    super(code); const copied = copyResponseDiagnostic(diagnostic);
    if (copied) {
      if (copied.envelope) {
        copied.envelope.unexpected.forEach(Object.freeze); Object.freeze(copied.envelope.unexpected);
        Object.freeze(copied.envelope.missing); Object.freeze(copied.envelope);
      }
      Object.defineProperty(this, 'responseDiagnostic', { value: Object.freeze(copied) });
    }
  }
}
export const READONLY_LIVE_HTTP_LIMITS = Object.freeze({ headersBytes: 8 * 1024, headersCount: 32,
  responseBytes: 256 * 1024, frameBytes: 64 * 1024, frames: 2048, outputBytes: 16 * 1024,
  workTimeoutMs: 55_000, cleanupTimeoutMs: 5_000 });
export const READONLY_LIVE_V2_HTTP_LIMITS = Object.freeze({ ...READONLY_LIVE_HTTP_LIMITS, headersBytes: 16 * 1024, headersCount: 64 });
const fail: (suffix?: string) => never = (suffix = 'INVALID_RESPONSE') => { throw new HarnessError(`READONLY_LIVE_${suffix}`); };
export const getReadonlyLiveHttpLimits = (profileId: ReadonlyLiveProfileId) => {
  if (profileId === 'codex-chatgpt-sse-v1') return READONLY_LIVE_HTTP_LIMITS;
  if (profileId === 'codex-chatgpt-sse-v2' || profileId === 'codex-chatgpt-sse-v3'
    || profileId === 'codex-chatgpt-sse-v4' || profileId === 'codex-chatgpt-sse-v5'
    || profileId === 'codex-chatgpt-sse-v6' || profileId === 'codex-chatgpt-sse-v7' || profileId === 'codex-chatgpt-sse-v8'
    || profileId === 'codex-chatgpt-sse-v9') return READONLY_LIVE_V2_HTTP_LIMITS;
  return fail('INVALID_PROFILE');
};
const diagnosticStages = ['JSON', 'RESPONSE_FIELDS', 'RESPONSE_METADATA', 'SSE_FRAME', 'SSE_EVENT', 'OUTPUT_ITEM',
  'HTTP_HEADERS', 'UTF8', 'FINAL_CONSISTENCY', 'TOOL_USAGE_ACTIVITY'] as const;
type DiagnosticStage = typeof diagnosticStages[number];
/** Diagnostics identify a fixed validation boundary, never untrusted fields or values. */
const checked = <T>(modern: boolean, stage: DiagnosticStage, validate: () => T): T => {
  if (!modern) return validate();
  try { return validate(); }
  catch (error) {
    if (error instanceof HarnessError && error.code !== 'READONLY_LIVE_INVALID_RESPONSE') throw error;
    return fail(`INVALID_RESPONSE_${stage}`);
  }
};
const object = (value: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail();
  return value as Record<string, unknown>;
};
/** Numeric token counts are usage metadata, never authentication values. */
const redactionView = (value: unknown, modern: boolean): unknown => {
  if (Array.isArray(value)) return value.map((child) => redactionView(child, modern));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const metric = (['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens', 'max_output_tokens'].includes(key)
      && (child === null || (Number.isSafeInteger(child) && (child as number) >= 0)))
      || (modern && key === 'cache_write_tokens' && Number.isSafeInteger(child) && (child as number) >= 0);
    const details = ['input_tokens_details', 'output_tokens_details'].includes(key) && child && typeof child === 'object' && !Array.isArray(child)
      && Object.entries(child).every(([name, count]) => ['cached_tokens', 'reasoning_tokens', ...(modern ? ['cache_write_tokens'] : [])].includes(name) && Number.isSafeInteger(count) && (count as number) >= 0);
    return [metric || details ? `count_${key.replaceAll('tokens', 'units')}` : key, redactionView(child, modern)];
  }));
};
/** Official tool accounting shape; exact keys and safe nonnegative counts narrow the supported contract. */
const toolUsageCounts = (value: unknown): number[] => {
  const usage = object(value, ['image_gen', 'web_search']);
  const image = object(usage.image_gen, ['input_tokens', 'input_tokens_details', 'output_tokens', 'total_tokens'],
    ['cached_tokens', 'cached_tokens_details', 'output_tokens_details']);
  const counts: unknown[] = [image.input_tokens, image.output_tokens, image.total_tokens];
  const details = (value: unknown, fields: string[]): void => { counts.push(...Object.values(object(value, fields))); };
  details(image.input_tokens_details, ['image_tokens', 'text_tokens']);
  if (image.output_tokens_details !== undefined) details(image.output_tokens_details, ['image_tokens', 'text_tokens']);
  if (image.cached_tokens !== undefined) counts.push(image.cached_tokens);
  if (image.cached_tokens_details !== undefined) details(image.cached_tokens_details, ['cached_image_tokens', 'cached_text_tokens']);
  details(usage.web_search, ['num_requests']);
  if (!counts.every(integer)) fail();
  return counts as number[];
};
/** Only a validated numeric subtree at the registered response path gets accounting aliases. */
const toolUsageRedactionView = (value: unknown, origin: ReadonlyLiveJsonDiagnostic['origin']): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  if (origin === 'sse' && !['response.created', 'response.in_progress', 'response.completed'].includes(envelope.type as string)) return value;
  const candidate = origin === 'response' ? envelope : envelope.response;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return value;
  const response = candidate as Record<string, unknown>;
  const completed = origin === 'response' || envelope.type === 'response.completed';
  if (response.object !== 'response' || response.model !== 'gpt-6.1-sol'
    || response.status !== (completed ? 'completed' : 'in_progress') || response.tool_usage === undefined) return value;
  try { toolUsageCounts(response.tool_usage); } catch { return value; }
  const project = (current: unknown): unknown => typeof current === 'number' ? current
    : Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([key, child]) =>
      [key.includes('tokens') ? `count_${key.replaceAll('tokens', 'units')}` : key, project(child)]));
  const projected = { ...response, tool_usage: project(response.tool_usage) };
  return origin === 'response' ? projected : { ...envelope, response: projected };
};
const parseJson = (raw: string, modern: boolean, origin: ReadonlyLiveJsonDiagnostic['origin'], typedToolUsage: boolean): unknown => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > READONLY_LIVE_HTTP_LIMITS.responseBytes) fail('RESPONSE_LIMIT');
  const rejectJson = (reason: ReadonlyLiveJsonDiagnostic['reason'], sensitive: ReadonlyLiveSensitiveDiagnostic | null = null,
    attribution: ReadonlyLiveSensitiveAttribution | null = null, matches: ReadonlyLiveSensitiveMatches | null = null): never => {
    throw new ReadonlyLiveJsonError('READONLY_LIVE_INVALID_RESPONSE', { origin, reason }, sensitive, attribution, matches);
  };
  let offset = 0;
  const whitespace = (): void => { while (offset < raw.length && /[\t\n\r ]/u.test(raw[offset]!)) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      const character = raw[offset++];
      if (character === '\\') { offset++; continue; }
      if (character === '"') {
        const text = JSON.parse(raw.slice(start, offset)) as string;
        if (Buffer.from(text).toString('utf8') !== text) rejectJson('unicode');
        return text;
      }
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (depth > 16) rejectJson('depth');
    whitespace();
    if (raw[offset] === '"') { string(); return; }
    if (raw[offset] === '{') {
      offset++; whitespace(); const keys = new Set<string>();
      if (raw[offset] === '}') { offset++; return; }
      while (offset < raw.length) {
        whitespace(); if (raw[offset] !== '"') fail();
        const key = string(); if (keys.has(key)) rejectJson('duplicate-key'); keys.add(key);
        whitespace(); if (raw[offset++] !== ':') fail(); value(depth + 1); whitespace();
        const end = raw[offset++]; if (end === '}') return; if (end !== ',') fail();
      }
      fail();
    }
    if (raw[offset] === '[') {
      offset++; whitespace(); if (raw[offset] === ']') { offset++; return; }
      while (offset < raw.length) {
        value(depth + 1); whitespace(); const end = raw[offset++]; if (end === ']') return; if (end !== ',') fail();
      }
      fail();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(raw.slice(offset));
    if (!token) return fail(); offset += token[0].length;
  };
  let phase: 'syntax' | 'canonicalization' = 'syntax';
  try {
    value(0); whitespace(); if (offset !== raw.length) fail();
    const parsed: unknown = JSON.parse(raw);
    phase = 'canonicalization';
    const redacted = redactionView(typedToolUsage ? toolUsageRedactionView(parsed, origin) : parsed, modern);
    const canonical = canonicalReadonlyJson(redacted);
    if (containsSensitiveText(canonical)) {
      let sensitive: ReadonlyLiveSensitiveDiagnostic | null = null;
      let attribution: ReadonlyLiveSensitiveAttribution | null = null;
      let matches: ReadonlyLiveSensitiveMatches | null = null;
      // Observation must never alter the original rejection, even if classification fails.
      try { sensitive = classifyReadonlyLiveSensitiveContent({ original: parsed, redacted, canonical, origin }); } catch { /* keep the original refusal */ }
      try { attribution = classifyReadonlyLiveSensitiveAttribution({ original: parsed, redacted, canonical, origin }); } catch { /* keep the original refusal */ }
      try { matches = classifyReadonlyLiveSensitiveMatches({ original: parsed, redacted, canonical, origin }); } catch { /* keep the original refusal */ }
      rejectJson('sensitive-content', sensitive, attribution, matches);
    }
    return parsed;
  } catch (error) { if (error instanceof ReadonlyLiveJsonError) throw error; return rejectJson(phase); }
};

const parse = (raw: string, modern = false, origin: ReadonlyLiveJsonDiagnostic['origin'] = 'response', typedToolUsage = false): Record<string, unknown> => {
  try { return parseJson(raw, modern, origin, typedToolUsage) as Record<string, unknown>; }
  catch (error) {
    const diagnostic = getReadonlyLiveJsonDiagnostic(error);
    const code = modern ? 'READONLY_LIVE_INVALID_RESPONSE_JSON' : 'READONLY_LIVE_INVALID_RESPONSE';
    if (diagnostic) throw new ReadonlyLiveJsonError(code, diagnostic, getReadonlyLiveSensitiveDiagnostic(error),
      getReadonlyLiveSensitiveAttribution(error), getReadonlyLiveSensitiveMatches(error));
    throw new HarnessError(code);
  }
};
const boundedText = (value: unknown, max = READONLY_LIVE_HTTP_LIMITS.outputBytes): string => {
  if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value || containsSensitiveText(value)) return fail();
  if (Buffer.byteLength(value) > max) fail('OUTPUT_LIMIT');
  return value;
};
const outputText = (value: unknown): string => { const text = boundedText(value); if (!text) fail(); return text; };
const id = (value: unknown, prefix: string): string => {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,128}$`, 'u').test(value)) return fail();
  return value;
};
const emptyArray = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
const optionalNull = (value: unknown): boolean => value === undefined || value === null;
const integer = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const textPart = (value: unknown, added = false): string => {
  const part = object(value, ['type', 'text', 'annotations'], ['logprobs']);
  if (part.type !== 'output_text' || !emptyArray(part.annotations)
    || (part.logprobs !== undefined && !emptyArray(part.logprobs))) fail();
  const text = boundedText(part.text); if (added && text !== '') fail();
  return text;
};
interface Item { id: string; type: 'message' | 'reasoning'; text: string; raw: unknown }
const validateItemRaw = (value: unknown, completed: boolean): Item => {
  const base = object(value, ['id', 'type'], ['role', 'status', 'content', 'summary', 'encrypted_content', 'channel']);
  if (base.type === 'message') {
    const item = object(base, ['id', 'type', 'role', 'status', 'content'], ['channel']);
    if (item.role !== 'assistant' || item.status !== (completed ? 'completed' : 'in_progress')
      || (item.channel !== undefined && item.channel !== 'final') || !Array.isArray(item.content)) fail();
    const parts = item.content as unknown[];
    if (parts.length !== (completed ? 1 : 0)) fail();
    return { id: id(item.id, 'msg'), type: 'message', text: completed ? outputText(textPart(parts[0])) : '', raw: value };
  }
  const item = object(base, ['id', 'type', 'summary'], ['status', 'encrypted_content']);
  if (item.type !== 'reasoning' || !Array.isArray(item.summary) || item.summary.length > 8
    || (!optionalNull(item.encrypted_content))
    || (item.status !== undefined && item.status !== (completed ? 'completed' : 'in_progress'))) fail();
  for (const value of item.summary as unknown[]) {
    const part = object(value, ['type', 'text']); if (part.type !== 'summary_text') fail(); boundedText(part.text);
  }
  if (!completed && (item.summary as unknown[]).length) fail();
  return { id: id(item.id, 'rs'), type: 'reasoning', text: '', raw: value };
};
const validateItem = (value: unknown, completed: boolean, modern = false): Item =>
  checked(modern, 'OUTPUT_ITEM', () => validateItemRaw(value, completed));
const responseOptionals = ['created_at', 'completed_at', 'background', 'error', 'incomplete_details', 'instructions',
  'max_output_tokens', 'max_tool_calls', 'parallel_tool_calls', 'previous_response_id', 'prompt_cache_key', 'prompt_cache_retention',
  'reasoning', 'safety_identifier', 'service_tier', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_logprobs', 'top_p',
  'truncation', 'usage', 'user', 'metadata'];
interface MetadataBoundary { field: ReadonlyLiveMetadataDiagnostic['field']; reason: ReadonlyLiveMetadataDiagnostic['reason'] }
const validateMetadata = (response: Record<string, unknown>, modern: boolean, typedToolUsage: boolean, boundary: MetadataBoundary): void => {
  boundary.field = 'tool-usage'; boundary.reason = 'shape';
  if (typedToolUsage && response.tool_usage !== undefined) {
    // Accounting metadata does not authorize tools. This readonly profile only supports zero recorded counts.
    if (toolUsageCounts(response.tool_usage).some((count) => count !== 0)) fail('INVALID_RESPONSE_TOOL_USAGE_ACTIVITY');
  }
  boundary.field = 'access-programs'; boundary.reason = 'value';
  if (modern && response.access_programs !== undefined && response.access_programs !== null) fail();
  boundary.field = 'error'; if (!optionalNull(response.error)) fail();
  boundary.field = 'incomplete-details'; if (!optionalNull(response.incomplete_details)) fail();
  boundary.field = 'tools'; if (response.tools !== undefined && !emptyArray(response.tools)) fail();
  boundary.field = 'tool-choice'; if (response.tool_choice !== undefined && !['none', 'auto'].includes(response.tool_choice as string)) fail();
  boundary.field = 'store'; if (response.store !== undefined && response.store !== false) fail();
  boundary.field = 'background'; if (response.background !== undefined && response.background !== false) fail();
  for (const [key, field] of [['created_at', 'created-at'], ['completed_at', 'completed-at'], ['max_output_tokens', 'max-output-tokens'],
    ['max_tool_calls', 'max-tool-calls'], ['top_logprobs', 'top-logprobs']] as const) {
    boundary.field = field; boundary.reason = 'integer';
    if (!optionalNull(response[key]) && !integer(response[key])) fail();
  }
  for (const [key, field] of [['temperature', 'temperature'], ['top_p', 'top-p']] as const) {
    boundary.field = field; boundary.reason = 'number';
    if (!optionalNull(response[key]) && (typeof response[key] !== 'number' || !Number.isFinite(response[key]))) fail();
  }
  boundary.field = 'parallel-tool-calls'; boundary.reason = 'value';
  if (response.parallel_tool_calls !== undefined && typeof response.parallel_tool_calls !== 'boolean') fail();
  for (const [key, field] of [['instructions', 'instructions'], ['previous_response_id', 'previous-response-id'],
    ['prompt_cache_key', 'prompt-cache-key'], ['prompt_cache_retention', 'prompt-cache-retention'], ['safety_identifier', 'safety-identifier'],
    ['service_tier', 'service-tier'], ['truncation', 'truncation'], ['user', 'user']] as const) {
    boundary.field = field; boundary.reason = 'text';
    if (!optionalNull(response[key])) boundedText(response[key], 8192);
  }
  boundary.field = 'reasoning'; boundary.reason = 'shape';
  if (response.reasoning !== undefined && !(modern && response.reasoning === null)) {
    const reasoning = object(response.reasoning, [], ['effort', 'summary', ...(modern ? ['context', 'mode'] : [])]);
    boundary.reason = 'text';
    for (const value of Object.values(reasoning)) if (value !== null) boundedText(value, 64);
    boundary.field = 'reasoning-context'; boundary.reason = 'value';
    if (modern && !optionalNull(reasoning.context) && !['auto', 'current_turn', 'all_turns'].includes(reasoning.context as string)) fail();
    boundary.field = 'reasoning-mode';
    if (modern && reasoning.mode !== undefined && !['standard', 'pro'].includes(reasoning.mode as string)) fail();
  }
  boundary.field = 'metadata'; boundary.reason = 'shape';
  if (response.metadata !== undefined && !(modern && response.metadata === null)) {
    if (!response.metadata || typeof response.metadata !== 'object' || Array.isArray(response.metadata)) fail();
    boundary.reason = 'size';
    if (Object.keys(response.metadata).length > 16 || Buffer.byteLength(canonicalReadonlyJson(response.metadata)) > 2048) fail();
    boundary.reason = 'text';
    for (const [key, value] of Object.entries(response.metadata)) { boundedText(key, 64); boundedText(value, 512); }
  }
  boundary.field = 'usage'; boundary.reason = 'shape';
  if (!optionalNull(response.usage)) {
    const usage = object(response.usage, ['input_tokens', 'output_tokens', 'total_tokens'], ['input_tokens_details', 'output_tokens_details']);
    boundary.field = 'usage-counts'; boundary.reason = 'integer';
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) if (!integer(usage[key])) fail();
    for (const [key, allowed, field] of [['input_tokens_details', ['cached_tokens', ...(modern ? ['cache_write_tokens'] : [])], 'usage-input-details'],
      ['output_tokens_details', ['reasoning_tokens'], 'usage-output-details']] as const) {
      boundary.field = field; boundary.reason = 'shape';
      if (usage[key] !== undefined) {
        const values = Object.values(object(usage[key], [], [...allowed]));
        boundary.reason = 'integer';
        for (const value of values) if (!integer(value)) fail();
      }
    }
  }
  boundary.field = 'text'; boundary.reason = 'shape';
  if (response.text !== undefined) {
    const text = object(response.text, ['format'], ['verbosity']);
    boundary.field = 'text-verbosity'; boundary.reason = 'text';
    if (text.verbosity !== undefined) boundedText(text.verbosity, 32);
    boundary.field = 'text-format'; boundary.reason = 'shape';
    const format = object(text.format, ['type'], ['name', 'schema', 'strict', ...(modern ? ['description'] : [])]);
    boundary.field = 'text-format-description'; boundary.reason = 'text';
    if (modern && format.description !== undefined) boundedText(format.description, 4096);
    boundary.field = 'text-format-type'; boundary.reason = 'value';
    if (!['text', 'json_schema', 'json_object'].includes(format.type as string)) fail();
    boundary.field = 'text-format-strict';
    if (format.strict !== undefined && typeof format.strict !== 'boolean') fail();
    boundary.field = 'text-format-name';
    if (format.name !== undefined && typeof format.name !== 'string') fail();
    boundary.field = 'text-format'; boundary.reason = 'size';
    if (Buffer.byteLength(canonicalReadonlyJson(format)) > 32 * 1024) fail();
  }
};
const validateResponseMetadata = (response: Record<string, unknown>, modern: boolean, typedToolUsage: boolean,
  event: ReadonlyLiveMetadataDiagnostic['event']): void => {
  const boundary: MetadataBoundary = { field: 'tool-usage', reason: 'shape' };
  try { checked(modern, 'RESPONSE_METADATA', () => validateMetadata(response, modern, typedToolUsage, boundary)); }
  catch (error) {
    if (modern && error instanceof HarnessError && error.code === 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_METADATA') {
      try {
        const diagnostic = copyReadonlyLiveMetadataDiagnostic({ event, field: boundary.field, reason: boundary.reason });
        if (diagnostic) {
          Object.defineProperty(error, 'metadataDiagnostic', { value: diagnostic });
          metadataDiagnostics.set(error, diagnostic);
        }
      } catch { /* Diagnostic collection cannot replace the original rejection. */ }
    }
    throw error;
  }
};
const validateResponseRaw = (value: unknown, completed: boolean, modern: boolean, typedToolUsage: boolean,
  diagnostic: ReadonlyLiveResponseDiagnostic, allowExtensions: boolean): { id: string; items: Item[]; text: string } => {
  const required = ['id', 'object', 'status', 'model', 'output'];
  const optional = [...responseOptionals, ...(modern ? ['access_programs'] : []), ...(typedToolUsage ? ['tool_usage'] : [])];
  let response: Record<string, unknown>; let candidate = value;
  try {
    if (allowExtensions) {
      const projection = projectReadonlyLiveResponseExtensions(value, [...required, ...optional]);
      if (projection.reason) { diagnostic.reason = projection.reason; fail(); }
      candidate = projection.value;
    }
    response = object(candidate, required, optional);
  }
  catch (error) {
    if (diagnostic.reason === 'envelope') {
      try { diagnostic.envelope = classifyReadonlyLiveResponseEnvelope(candidate, required, optional); } catch { diagnostic.envelope = null; }
    }
    throw error;
  }
  diagnostic.reason = 'object-marker'; if (response.object !== 'response') fail();
  diagnostic.reason = 'status'; if (response.status !== (completed ? 'completed' : 'in_progress')) fail();
  diagnostic.reason = 'model'; if (response.model !== 'gpt-6.1-sol') fail();
  diagnostic.reason = 'output-type'; if (!Array.isArray(response.output)) fail();
  validateResponseMetadata(response, modern, typedToolUsage, diagnostic.event);
  const output = response.output as unknown[];
  diagnostic.reason = 'output-count';
  if ((!completed && output.length !== 0) || output.length > 5) fail();
  const items = output.map((item) => validateItem(item, completed, modern));
  diagnostic.reason = 'duplicate-item-id';
  if (new Set(items.map((item) => item.id)).size !== items.length) fail();
  const messages = items.filter((item) => item.type === 'message');
  diagnostic.reason = 'assistant-count';
  if (completed && (messages.length !== 1 || items.at(-1)?.type !== 'message')) fail();
  diagnostic.reason = 'response-id';
  return { id: id(response.id, 'resp'), items, text: messages[0]?.text ?? '' };
};
const validateResponse = (value: unknown, completed: boolean, modern = false, typedToolUsage = false,
  event: ReadonlyLiveResponseDiagnostic['event'] = 'direct-response', allowExtensions = false) => {
  const diagnostic: ReadonlyLiveResponseDiagnostic = { event, reason: 'envelope', envelope: null };
  try { return checked(modern, 'RESPONSE_FIELDS', () => validateResponseRaw(value, completed, modern, typedToolUsage, diagnostic, allowExtensions)); }
  catch (error) {
    if (modern && error instanceof HarnessError && error.code === 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS') {
      throw new ReadonlyLiveResponseError(error.code, diagnostic);
    }
    throw error;
  }
};
interface StreamItem { item: Item; done: boolean; text: string; textDone: boolean; partStarted: boolean; partDone: boolean;
  summaries: { text: string; textDone: boolean; done: boolean }[] }

// Existing protocol fields cannot be reinterpreted as opaque boolean additions.
const createdEnvelopeReservedKeys = new Set(['type', 'sequence_number', 'response', 'response_id', 'output_index', 'item', 'item_id',
  'content_index', 'part', 'delta', 'text', 'summary_index', 'obfuscation', 'logprobs', 'event_id', 'id', 'created_at',
  'stream_id', 'object', 'model', 'status', 'usage', 'tools', 'tool_usage', 'tool_calls', 'function_call', 'function',
  'error', 'refusal', 'output', 'incomplete_details', 'tool_choice',
  '__proto__', 'constructor', 'prototype']);
/** v8 ignores one bounded boolean extension on the first created envelope, never on nested response data. */
const projectCreatedEnvelope = (event: Record<string, unknown>, required: string[]): Record<string, unknown> => {
  const extras = Object.keys(event).filter((key) => !required.includes(key));
  if (extras.length !== 1) return event;
  const key = extras[0]!;
  if (createdEnvelopeReservedKeys.has(key) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || typeof event[key] !== 'boolean') return event;
  const projected = { ...event }; delete projected[key]; return projected;
};

/** The final response must agree with every streamed item and text fragment. */
class LiveSseDecoder {
  private pending = ''; private frame: string[] = []; private frameBytes = 0; private frameCount = 0;
  private sequence = 0; private responseId = ''; private finished = false; private inProgress = false;
  private eventBoundary: ReadonlyLiveSseDiagnostic['reason'] = 'event-type';
  private envelopeDiagnostic: ReadonlyLiveSseEnvelopeDiagnostic | null = null;
  private readonly items: StreamItem[] = [];
  constructor(private readonly modern = false, private readonly typedToolUsage = false, private readonly compatibleSequenceStart = false,
    private readonly createdBooleanExtension = false, private readonly responseExtensions = false) {}
  feed(text: string): void { checked(this.modern, 'SSE_FRAME', () => this.feedFrames(text)); }
  private feedFrames(text: string): void {
    this.pending += text; let end: number;
    while ((end = this.pending.indexOf('\n')) !== -1) {
      const raw = this.pending.slice(0, end + 1); this.pending = this.pending.slice(end + 1);
      this.frameBytes += Buffer.byteLength(raw); if (this.frameBytes > READONLY_LIVE_HTTP_LIMITS.frameBytes) fail('FRAME_LIMIT');
      const line = raw.slice(0, -1).replace(/\r$/u, ''); if (line.includes('\r') || line.includes('\0')) fail();
      if (!line) { if (++this.frameCount > READONLY_LIVE_HTTP_LIMITS.frames) fail('FRAME_LIMIT'); this.acceptFrame(); this.frame = []; this.frameBytes = 0; }
      else this.frame.push(line);
    }
    if (this.frameBytes + Buffer.byteLength(this.pending) > READONLY_LIVE_HTTP_LIMITS.frameBytes) fail('FRAME_LIMIT');
  }
  finish(): string { return checked(this.modern, 'FINAL_CONSISTENCY', () => this.finalText()); }
  private finalText(): string {
    if (this.pending || this.frame.length || this.frameBytes || !this.finished) fail();
    return outputText(this.items.find((item) => item.item.type === 'message')?.text);
  }
  private acceptFrame(): void {
    let eventName: string | null = null; const data: string[] = [];
    for (const line of this.frame) {
      if (line.startsWith(':')) { if (containsSensitiveText(line)) fail(); continue; }
      const colon = line.indexOf(':'); if (colon === -1) fail();
      const name = line.slice(0, colon); const value = line.slice(colon + 1).replace(/^ /u, '');
      if (name === 'event') { if (eventName !== null) fail(); eventName = value; }
      else if (name === 'data') data.push(value); else fail();
    }
    if (eventName === null && !data.length) return;
    if (this.finished || !data.length) fail();
    const event = parse(data.join('\n'), this.modern, 'sse', this.typedToolUsage);
    const position = this.sequence === 0 ? 'first' : 'later';
    this.eventBoundary = 'event-type'; this.envelopeDiagnostic = null;
    try {
      checked(this.modern, 'SSE_EVENT', () => {
        if (!event || typeof event.type !== 'string') fail();
        this.eventBoundary = 'event-name'; if (eventName !== null && event.type !== eventName) fail();
        this.eventBoundary = 'sequence-missing'; if (!Object.hasOwn(event, 'sequence_number')) fail();
        this.eventBoundary = 'sequence-invalid'; if (!integer(event.sequence_number)) fail();
        this.eventBoundary = position === 'first' ? 'sequence-start' : 'sequence-step';
        // Both documented starts are supported; gaps, duplicates and backwards steps remain forbidden.
        if (this.compatibleSequenceStart && position === 'first' && event.sequence_number === 1) this.sequence = 1;
        if (event.sequence_number !== this.sequence++) fail();
        this.acceptEvent(event, position === 'first');
      });
    } catch (error) {
      if (!this.modern || !(error instanceof HarnessError) || error.code !== 'READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT') throw error;
      const number = event?.sequence_number;
      const sequence: ReadonlyLiveSseDiagnostic['sequence'] = !event || !Object.hasOwn(event, 'sequence_number') ? 'missing'
        : !integer(number) ? 'invalid' : number === 0 ? 'zero' : number === 1 ? 'one' : 'later';
      const reason = this.eventBoundary as ReadonlyLiveSseDiagnostic['reason'];
      throw new ReadonlyLiveSseError(error.code, { event: sseEventClass(event?.type), reason, sequence, position },
        reason === 'envelope' ? this.envelopeDiagnostic : null);
    }
  }
  private eventObject(value: unknown, required: string[], optional: string[] = [], createdExtension = false): Record<string, unknown> {
    try { return object(createdExtension ? projectCreatedEnvelope(value as Record<string, unknown>, required) : value, required, optional); }
    catch (error) {
      try { this.envelopeDiagnostic = classifyReadonlyLiveSseEnvelope(value, required, optional); }
      catch { this.envelopeDiagnostic = null; }
      throw error;
    }
  }
  private acceptEvent(event: Record<string, unknown>, first: boolean): void {
    const type = event.type as string;
    const envelope = ['type', 'sequence_number'];
    if (['response.created', 'response.in_progress', 'response.completed'].includes(type)) {
      this.eventBoundary = 'envelope';
      this.eventObject(event, [...envelope, 'response'], [], this.createdBooleanExtension && first && type === 'response.created');
      const responseEvent = type === 'response.created' ? 'created' : type === 'response.in_progress' ? 'in-progress' : 'completed';
      const result = validateResponse(event.response, type === 'response.completed', this.modern, this.typedToolUsage, responseEvent, this.responseExtensions);
      this.eventBoundary = 'state';
      if (type === 'response.created') { if (this.responseId) fail(); this.responseId = result.id; return; }
      this.eventBoundary = 'identity';
      if (!this.responseId || this.responseId !== result.id) fail();
      this.eventBoundary = 'order';
      if (type === 'response.in_progress') { if (this.inProgress || this.items.length) fail(); this.inProgress = true; return; }
      checked(this.modern, 'FINAL_CONSISTENCY', () => {
        if (result.items.length !== this.items.length || !this.items.length || this.items.some((item) => !item.done)
          || result.items.some((item, index) => canonicalReadonlyJson(item.raw) !== canonicalReadonlyJson(this.items[index]!.item.raw))) fail();
      });
      this.finished = true; return;
    }
    this.eventBoundary = 'order'; if (!this.responseId) fail();
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      this.eventBoundary = 'envelope';
      this.eventObject(event, [...envelope, 'output_index', 'item'], ['response_id']); this.responseIdentity(event);
      this.eventBoundary = 'index';
      if (!integer(event.output_index)) fail();
      const index = event.output_index as number;
      if (type === 'response.output_item.added') {
        const item = validateItem(event.item, false, this.modern);
        this.eventBoundary = 'order';
        if (index !== this.items.length || index >= 5 || this.items.some((old) => !old.done || old.item.id === item.id)
          || this.items.some((old) => old.item.type === 'message')) fail();
        this.items.push({ item, done: false, text: '', textDone: false, partStarted: false, partDone: false, summaries: [] }); return;
      }
      const state = this.items[index]; const done = validateItem(event.item, true, this.modern);
      this.eventBoundary = 'state';
      if (!state || state.done || state.item.id !== done.id || state.item.type !== done.type) fail();
      this.eventBoundary = 'text-consistency';
      if (done.type === 'message' && (!state.textDone || state.text !== done.text || (state.partStarted && !state.partDone))) fail();
      if (done.type === 'reasoning' && state.summaries.length) {
        const summary = (done.raw as { summary: unknown[] }).summary;
        if (state.summaries.some((part) => !part.done) || canonicalReadonlyJson(summary)
          !== canonicalReadonlyJson(state.summaries.map((part) => ({ type: 'summary_text', text: part.text })))) fail();
      }
      state.done = true; state.item = done; return;
    }
    if (type.startsWith('response.reasoning_summary_')) { this.acceptSummary(event); return; }
    this.eventBoundary = 'unsupported-event';
    if (!['response.content_part.added', 'response.content_part.done', 'response.output_text.delta', 'response.output_text.done'].includes(type)) fail();
    const state = this.items[event.output_index as number];
    this.eventBoundary = 'index';
    if (!integer(event.output_index) || !state || state.done || state.item.type !== 'message' || event.item_id !== state.item.id || event.content_index !== 0) fail();
    this.responseIdentity(event);
    if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      this.eventBoundary = 'envelope';
      this.eventObject(event, [...envelope, 'item_id', 'output_index', 'content_index', 'part'], ['response_id']);
      const added = type === 'response.content_part.added'; const text = textPart(event.part, added);
      this.eventBoundary = 'text-consistency';
      if (added) { if (state.partStarted || state.textDone || state.text) fail(); state.partStarted = true; }
      else { if (!state.partStarted || state.partDone || !state.textDone || text !== state.text) fail(); state.partDone = true; }
      return;
    }
    if (type === 'response.output_text.delta') {
      this.eventBoundary = 'envelope';
      this.eventObject(event, [...envelope, 'item_id', 'output_index', 'content_index', 'delta'], ['response_id', 'obfuscation', 'logprobs']);
      this.eventBoundary = 'state';
      if (state.textDone || (event.logprobs !== undefined && !emptyArray(event.logprobs))) fail();
      if (event.obfuscation !== undefined) boundedText(event.obfuscation, 1024);
      this.eventBoundary = 'text-consistency'; state.text = boundedText(state.text + boundedText(event.delta)); return;
    }
    if (type === 'response.output_text.done') {
      this.eventBoundary = 'envelope';
      this.eventObject(event, [...envelope, 'item_id', 'output_index', 'content_index', 'text'], ['response_id', 'logprobs']);
      this.eventBoundary = 'text-consistency';
      if (state.textDone || outputText(event.text) !== state.text || (event.logprobs !== undefined && !emptyArray(event.logprobs))) fail();
      state.textDone = true; return;
    }
    this.eventBoundary = 'unsupported-event'; fail();
  }
  private responseIdentity(event: Record<string, unknown>): void {
    this.eventBoundary = 'identity'; if (event.response_id !== undefined && event.response_id !== this.responseId) fail();
  }
  private acceptSummary(event: Record<string, unknown>): void {
    const state = this.items[event.output_index as number]; const type = event.type as string;
    this.eventBoundary = 'unsupported-event';
    if (!['response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done'].includes(type)) fail();
    this.eventBoundary = 'index';
    if (!integer(event.output_index) || !state || state.done || state.item.type !== 'reasoning' || event.item_id !== state.item.id || !integer(event.summary_index)) fail();
    this.responseIdentity(event); const index = event.summary_index as number;
    const keys = ['type', 'sequence_number', 'item_id', 'output_index', 'summary_index'];
    if (type === 'response.reasoning_summary_part.added') {
      this.eventBoundary = 'envelope';
      this.eventObject(event, [...keys, 'part'], ['response_id']); const part = object(event.part, ['type', 'text']);
      this.eventBoundary = 'order';
      if (part.type !== 'summary_text' || part.text !== '' || index !== state.summaries.length || index >= 8
        || state.summaries.some((part) => !part.done)) fail();
      state.summaries.push({ text: '', textDone: false, done: false }); return;
    }
    this.eventBoundary = 'state'; const summary = state.summaries[index]; if (!summary || summary.done) fail();
    if (type === 'response.reasoning_summary_text.delta') {
      this.eventBoundary = 'envelope'; this.eventObject(event, [...keys, 'delta'], ['response_id']);
      this.eventBoundary = 'state'; if (summary.textDone) fail();
      this.eventBoundary = 'text-consistency'; summary.text = boundedText(summary.text + boundedText(event.delta)); return;
    }
    if (type === 'response.reasoning_summary_text.done') {
      this.eventBoundary = 'envelope'; this.eventObject(event, [...keys, 'text'], ['response_id']);
      this.eventBoundary = 'text-consistency'; if (summary.textDone || boundedText(event.text) !== summary.text) fail(); summary.textDone = true; return;
    }
    if (type === 'response.reasoning_summary_part.done') {
      this.eventBoundary = 'envelope';
      this.eventObject(event, [...keys, 'part'], ['response_id']); const part = object(event.part, ['type', 'text']);
      this.eventBoundary = 'text-consistency';
      if (!summary.textDone || part.type !== 'summary_text' || boundedText(part.text) !== summary.text) fail(); summary.done = true; return;
    }
    this.eventBoundary = 'unsupported-event'; fail();
  }
}
const decodeHeaderReasons = ['RESPONSE_SHAPE', 'HEADER_PAIR_SHAPE', 'NAME_TOKEN', 'VALUE_CHARACTER', 'DUPLICATE_HEADER',
  'STATUS', 'LOCATION_POLICY', 'RETRY_AFTER_POLICY', 'CONTENT_ENCODING', 'CONTENT_TYPE_MISSING', 'CONTENT_TYPE_FORMAT', 'CONTENT_TYPE_CHARSET'] as const;
type DecodeHeaderReason = typeof decodeHeaderReasons[number];
const rejectHeader: (reason: DecodeHeaderReason) => never = (reason) => fail(`INVALID_RESPONSE_DECODE_${reason}`);
const httpToken = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const trimHttpWhitespace = (value: string): string => value.replace(/^[ \t]+|[ \t]+$/gu, '');

/** v4 normalizes HTTP syntax only; unknown parameters and non-identity encodings stay forbidden. */
const normalizedResponseMediaType = (raw: string): boolean => {
  const value = trimHttpWhitespace(raw);
  const separator = value.indexOf(';');
  const mediaType = trimHttpWhitespace(separator === -1 ? value : value.slice(0, separator)).toLowerCase();
  if (mediaType !== 'text/event-stream' && mediaType !== 'application/json') rejectHeader('CONTENT_TYPE_FORMAT');
  if (separator !== -1) {
    const parameter = trimHttpWhitespace(value.slice(separator + 1));
    const equals = parameter.indexOf('=');
    if (equals === -1 || parameter.slice(0, equals).toLowerCase() !== 'charset') rejectHeader('CONTENT_TYPE_FORMAT');
    const encoded = parameter.slice(equals + 1);
    let charset: string;
    if (encoded.startsWith('"')) {
      if (!/^"[^"\\]*"$/u.test(encoded)) rejectHeader('CONTENT_TYPE_FORMAT');
      charset = encoded.slice(1, -1);
    } else {
      if (!httpToken.test(encoded)) rejectHeader('CONTENT_TYPE_FORMAT');
      charset = encoded;
    }
    if (charset.toLowerCase() !== 'utf-8') rejectHeader('CONTENT_TYPE_CHARSET');
  }
  return mediaType === 'text/event-stream';
};
const validateCompatibleHeaders = (response: ReadonlyLiveHttpResponse, limits: ReturnType<typeof getReadonlyLiveHttpLimits>,
  allowMissingContentType = false): boolean | null => {
  if (!readonlyExactKeys(response, ['status', 'headers', 'body']) || !Array.isArray(response.headers)) rejectHeader('RESPONSE_SHAPE');
  if (response.headers.length > limits.headersCount) fail('HEADER_LIMIT');
  let bytes = 0; const headers = new Map<string, string>();
  for (const pair of response.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') rejectHeader('HEADER_PAIR_SHAPE');
    const [name, value] = pair;
    if (!httpToken.test(name)) rejectHeader('NAME_TOKEN');
    if (/[^\t\x20-\x7e]/u.test(value)) rejectHeader('VALUE_CHARACTER');
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > limits.headersBytes) fail('HEADER_LIMIT');
    const key = name.toLowerCase();
    if (key === 'set-cookie') continue;
    if (headers.has(key)) rejectHeader('DUPLICATE_HEADER');
    headers.set(key, value);
  }
  if (!Number.isInteger(response.status) || response.status !== 200) rejectHeader('STATUS');
  if (headers.has('location')) rejectHeader('LOCATION_POLICY');
  if (headers.has('retry-after')) rejectHeader('RETRY_AFTER_POLICY');
  const encoding = headers.get('content-encoding');
  if (encoding !== undefined && trimHttpWhitespace(encoding).toLowerCase() !== 'identity') rejectHeader('CONTENT_ENCODING');
  const contentType = headers.get('content-type');
  if (contentType === undefined) {
    if (allowMissingContentType) return null;
    rejectHeader('CONTENT_TYPE_MISSING');
  }
  return normalizedResponseMediaType(contentType);
};

/** Select one existing strict parser; never discard leading bytes or guess from arbitrary text. */
class MissingContentTypeDetector {
  private prefix = '';
  feed(text: string): boolean | null {
    for (const character of text) {
      if (!this.prefix && /^[ \t\r\n]$/u.test(character)) continue;
      this.prefix += character;
      if (this.prefix === '{') return false;
      if (this.prefix === ':' || this.prefix === 'event:' || this.prefix === 'data:') return true;
      if (!['event:', 'data:'].some((allowed) => allowed.startsWith(this.prefix))) fail('INVALID_RESPONSE_DECODE_BODY_FORMAT');
    }
    return null;
  }
}

const validateHeaders = (response: ReadonlyLiveHttpResponse, limits: ReturnType<typeof getReadonlyLiveHttpLimits>, modern: boolean): boolean => {
  if (!readonlyExactKeys(response, ['status', 'headers', 'body']) || !Array.isArray(response.headers)) fail();
  if (response.headers.length > limits.headersCount) fail('HEADER_LIMIT');
  let bytes = 0; const headers = new Map<string, string>();
  for (const pair of response.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((value) => typeof value !== 'string' || /[^\x20-\x7e]/u.test(value))) fail();
    const [name, value] = pair; if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(name)) fail();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > limits.headersBytes) fail('HEADER_LIMIT');
    const key = name.toLowerCase();
    // Cookies count toward both bounds but never enter the parser's retained header view.
    if (modern && key === 'set-cookie') continue;
    if (headers.has(key)) fail(); headers.set(key, value);
  }
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) fail();
  if (response.status !== 200) fail(`HTTP_${response.status}`);
  if (headers.has('location') || headers.has('retry-after')
    || (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity')) fail();
  const mime = headers.get('content-type') ?? '';
  if (!/^(?:text\/event-stream|application\/json)(?:;\s*charset=utf-8)?$/iu.test(mime)) fail();
  return /^text\/event-stream/iu.test(mime);
};

/** Read at most one bounded response, and bound cleanup even for a stalled iterator. */
export const decodeReadonlyLiveResponse = async (
  response: ReadonlyLiveHttpResponse | Response, signal: AbortSignal, options: ReadonlyLiveDecodeOptions = {},
): Promise<ReadonlyLiveDecodedResponse> => {
  const limits = getReadonlyLiveHttpLimits(options.profileId ?? 'codex-chatgpt-sse-v1');
  const responseExtensions = options.profileId === 'codex-chatgpt-sse-v9';
  const createdBooleanExtension = options.profileId === 'codex-chatgpt-sse-v8' || responseExtensions;
  const compatibleSequenceStart = options.profileId === 'codex-chatgpt-sse-v7' || createdBooleanExtension;
  const typedToolUsage = options.profileId === 'codex-chatgpt-sse-v6' || compatibleSequenceStart;
  const allowMissingContentType = options.profileId === 'codex-chatgpt-sse-v5' || typedToolUsage;
  const modern = options.profileId === 'codex-chatgpt-sse-v3' || options.profileId === 'codex-chatgpt-sse-v4' || allowMissingContentType;
  const compatibleHeaders = options.profileId === 'codex-chatgpt-sse-v4' || allowMissingContentType;
  const workMs = options.workTimeoutMs ?? READONLY_LIVE_HTTP_LIMITS.workTimeoutMs;
  const cleanupMs = options.cleanupTimeoutMs ?? READONLY_LIVE_HTTP_LIMITS.cleanupTimeoutMs;
  if (![workMs, cleanupMs].every((value) => Number.isInteger(value) && value > 0)
    || workMs > READONLY_LIVE_HTTP_LIMITS.workTimeoutMs || cleanupMs > READONLY_LIVE_HTTP_LIMITS.cleanupTimeoutMs
    || Object.keys(options).some((key) => !['workTimeoutMs', 'cleanupTimeoutMs', 'profileId'].includes(key))) fail();
  let iterator: AsyncIterator<Uint8Array> | null = null; let finished = false;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; }); void aborted.catch(() => undefined);
  const abort = (): void => rejectAbort(new HarnessError('READONLY_LIVE_CANCELLED'));
  signal.addEventListener('abort', abort, { once: true });
  const workTimer = setTimeout(() => rejectAbort(new HarnessError('READONLY_LIVE_TIMEOUT')), workMs);
  const deadline = performance.now() + workMs;
  let localMetadataError: object | null = null;
  const trackLocalMetadataFailure = <T>(validate: () => T): T => {
    try { return validate(); }
    catch (error) {
      if (error && typeof error === 'object' && metadataDiagnostics.has(error)) localMetadataError = error;
      throw error;
    }
  };
  try {
    const normalized: ReadonlyLiveHttpResponse = response instanceof Response
      ? { status: response.status, headers: [...response.headers.entries()], body: response.body as unknown as AsyncIterable<Uint8Array> } : response;
    if (!normalized?.body || typeof normalized.body[Symbol.asyncIterator] !== 'function') {
      if (compatibleHeaders) rejectHeader('RESPONSE_SHAPE');
      fail();
    }
    iterator = normalized.body[Symbol.asyncIterator](); if (!iterator || typeof iterator.next !== 'function') fail();
    if (signal.aborted) fail('CANCELLED');
    let stream = compatibleHeaders ? validateCompatibleHeaders(normalized, limits, allowMissingContentType)
      : checked(modern, 'HTTP_HEADERS', () => validateHeaders(normalized, limits, modern)); const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const sse = new LiveSseDecoder(modern, typedToolUsage, compatibleSequenceStart, createdBooleanExtension, responseExtensions); const hash = createHash('sha256'); let bytes = 0; let json = '';
    const detector = stream === null ? new MissingContentTypeDetector() : null; let pending = '';
    const feed = (text: string): void => {
      if (stream === null) {
        pending += text;
        stream = detector!.feed(text);
        if (stream === null) return;
        text = pending; pending = '';
      }
      if (stream) trackLocalMetadataFailure(() => sse.feed(text)); else json += text;
    };
    for (;;) {
      if (signal.aborted) fail('CANCELLED'); if (performance.now() >= deadline) fail('TIMEOUT');
      const part = await Promise.race([Promise.resolve().then(() => iterator!.next()), aborted]);
      if (signal.aborted) fail('CANCELLED'); if (performance.now() >= deadline) fail('TIMEOUT');
      if (!part || typeof part !== 'object' || typeof part.done !== 'boolean') fail();
      if (part.done) { finished = true; break; }
      if (!(part.value instanceof Uint8Array)) fail();
      bytes += part.value.byteLength; if (bytes > READONLY_LIVE_HTTP_LIMITS.responseBytes) fail('RESPONSE_LIMIT');
      hash.update(part.value);
      const text = checked(modern, 'UTF8', () => { try { return decoder.decode(part.value, { stream: true }); } catch { return fail(); } });
      feed(text);
    }
    const tail = checked(modern, 'UTF8', () => { try { return decoder.decode(); } catch { return fail(); } });
    feed(tail);
    if (stream === null) fail('INVALID_RESPONSE_DECODE_BODY_FORMAT');
    const text = trackLocalMetadataFailure(() => stream ? sse.finish()
      : validateResponse(parse(json, modern, 'response', typedToolUsage), true, modern, typedToolUsage, 'direct-response', responseExtensions).text);
    if (signal.aborted) fail('CANCELLED'); if (performance.now() >= deadline) fail('TIMEOUT');
    return { text, responseHash: hash.digest('hex') };
  } catch (error) {
    if (modern && error !== localMetadataError && error && typeof error === 'object' && metadataDiagnostics.has(error)) {
      const code = Object.getOwnPropertyDescriptor(error, 'code');
      // A transport may replay a genuine error from another decode; it cannot attest this response's boundary.
      if (code && Object.hasOwn(code, 'value') && code.value === 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_METADATA') {
        throw new HarnessError(code.value);
      }
    }
    if (error instanceof HarnessError && ((allowMissingContentType && error.code === 'READONLY_LIVE_INVALID_RESPONSE_DECODE_BODY_FORMAT')
      || (compatibleHeaders && decodeHeaderReasons.some((reason) => error.code === `READONLY_LIVE_INVALID_RESPONSE_DECODE_${reason}`))
      || (modern && diagnosticStages.some((stage) => error.code === `READONLY_LIVE_INVALID_RESPONSE_${stage}`))
      || /^READONLY_LIVE_HTTP_[1-5]\d{2}$/u.test(error.code)
      || ['INVALID_RESPONSE', 'RESPONSE_LIMIT', 'OUTPUT_LIMIT', 'HEADER_LIMIT', 'FRAME_LIMIT', 'TIMEOUT', 'CANCELLED', 'LIFECYCLE_UNSAFE'].some((suffix) => error.code === `READONLY_LIVE_${suffix}`))) throw error;
    return fail();
  } finally {
    clearTimeout(workTimer); signal.removeEventListener('abort', abort);
    if (iterator && !finished) {
      let timer: ReturnType<typeof setTimeout> | undefined; const cleanupDeadline = performance.now() + cleanupMs;
      try {
        if (typeof iterator.return !== 'function') fail('LIFECYCLE_UNSAFE');
        const result = await Promise.race([Promise.resolve().then(() => iterator!.return!()), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HarnessError('READONLY_LIVE_LIFECYCLE_UNSAFE')), cleanupMs);
        })]);
        if (result?.done !== true || performance.now() >= cleanupDeadline) fail('LIFECYCLE_UNSAFE');
      } catch { fail('LIFECYCLE_UNSAFE'); } finally { clearTimeout(timer); }
    }
  }
};
