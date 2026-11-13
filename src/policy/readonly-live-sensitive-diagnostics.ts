import { getSensitivePatternDefinitions, type SensitivePatternKind } from './redaction.js';

const patterns = ['private-key-block', 'provider-key-prefix', 'bearer-token', 'credential-assignment', 'other', 'multiple'] as const;
const areas = ['known-usage-counter', 'output-text', 'reasoning-text', 'instructions', 'schema', 'metadata', 'other', 'multiple'] as const;
const fields = ['cache-write-details', 'cache-write-ttl', 'input-details', 'output-details', 'other', 'not-applicable', 'multiple'] as const;
const shapes = ['null', 'integer', 'count-object', 'other', 'not-applicable', 'multiple'] as const;
export interface ReadonlyLiveSensitiveDiagnostic {
  pattern: typeof patterns[number];
  area: typeof areas[number];
  usageField: typeof fields[number];
  usageShape: typeof shapes[number];
}
const other = (): ReadonlyLiveSensitiveDiagnostic => ({ pattern: 'other', area: 'other', usageField: 'not-applicable', usageShape: 'not-applicable' });
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = (string | number)[];
type Label = Pick<ReadonlyLiveSensitiveDiagnostic, 'area' | 'usageField' | 'usageShape'>;
const plain = (value: Json | undefined): value is { [key: string]: Json } => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const at = (value: Json, path: Path): Json | undefined => {
  let current: Json | undefined = value;
  for (const key of path) current = current && typeof current === 'object' && Object.hasOwn(current, key)
    ? (current as Record<string | number, Json>)[key] : undefined;
  return current;
};
const begins = (path: Path, prefix: Path): boolean => prefix.every((part, index) => path[index] === part);
const exact = (value: { [key: string]: Json }, required: string[], optional: string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const count = (value: Json | undefined): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Reject non-JSON objects and accessors without invoking them. Limits bound diagnostic work only. */
const snapshot = (input: unknown): Json => {
  let nodes = 0; let characters = 0;
  const visit = (value: unknown, depth: number): Json => {
    if (++nodes > 131072 || depth > 16) throw new Error();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(); return value; }
    if (typeof value === 'string') { characters += value.length; if (characters > 524288) throw new Error(); return value; }
    if (!value || typeof value !== 'object') throw new Error();
    const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) throw new Error();
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 131072 || keys.length !== (length as number) + 1) throw new Error();
      return Array.from({ length: length as number }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) throw new Error();
        return visit(property.value, depth + 1);
      });
    }
    const entries: [string, Json][] = [];
    for (const key of keys as string[]) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw new Error();
      characters += key.length; if (characters > 524288) throw new Error();
      entries.push([key, visit(property.value, depth + 1)]);
    }
    return Object.fromEntries(entries);
  };
  return visit(input, 0);
};

const counterDetails = (value: Json | undefined): boolean => value === null || (plain(value)
  && exact(value, ['ttl_12h_tokens', 'ttl_30m_tokens']) && Object.values(value).every(count));
const knownUsage = (value: Json | undefined): value is { [key: string]: Json } => {
  if (!plain(value) || !exact(value, ['input_tokens', 'output_tokens', 'total_tokens'], ['input_tokens_details', 'output_tokens_details'])
    || !['input_tokens', 'output_tokens', 'total_tokens'].every((key) => count(value[key]))) return false;
  const input = value.input_tokens_details;
  if (input !== undefined && input !== null && (!plain(input) || Object.keys(input).length === 0
    || !exact(input, [], ['cached_tokens', 'cache_write_tokens', 'cache_write_tokens_details'])
    || Object.entries(input).some(([key, child]) => key === 'cache_write_tokens_details' ? !counterDetails(child) : !count(child)))) return false;
  const output = value.output_tokens_details;
  return output === undefined || output === null || (plain(output) && exact(output, ['reasoning_tokens']) && count(output.reasoning_tokens));
};
const aliases: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  'input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens', 'cache_write_tokens', 'input_tokens_details', 'output_tokens_details',
].map((key) => [`count_${key.replaceAll('tokens', 'units')}`, key])));
const originalKey = (key: string): string => Object.hasOwn(aliases, key) ? aliases[key]! : key;
/** Only numeric/null values and the known key renamings may differ in a counter projection. */
const counterProjection = (original: Json, redacted: Json | undefined): boolean => {
  if (!plain(original)) return original === redacted;
  if (!plain(redacted) || Object.keys(original).length !== Object.keys(redacted).length) return false;
  const seen = new Set<string>();
  return Object.entries(redacted).every(([key, value]) => {
    const source = originalKey(key);
    if (seen.has(source) || !Object.hasOwn(original, source)) return false;
    seen.add(source); return counterProjection(original[source]!, value);
  });
};
const shape = (value: Json | undefined): ReadonlyLiveSensitiveDiagnostic['usageShape'] =>
  value === null ? 'null' : count(value) ? 'integer' : plain(value) ? 'count-object' : 'other';
const label = (area: Label['area']): Label => ({ area, usageField: 'not-applicable', usageShape: 'not-applicable' });

const labeler = (original: Json, redacted: Json, origin: 'response' | 'sse') => {
  let responsePath: Path | null = null;
  if (origin === 'response' && at(original, ['object']) === 'response' && at(redacted, ['object']) === 'response') responsePath = [];
  if (origin === 'sse' && ['response.created', 'response.in_progress', 'response.completed'].includes(String(at(original, ['type'])))
    && at(original, ['type']) === at(redacted, ['type']) && at(original, ['response', 'object']) === 'response'
    && at(redacted, ['response', 'object']) === 'response') responsePath = ['response'];
  const usagePath = responsePath && [...responsePath, 'usage'];
  const usage = usagePath ? at(original, usagePath) : undefined;
  const trustedUsage = usagePath !== null && knownUsage(usage) && counterProjection(usage, at(redacted, usagePath));
  return (path: Path): Label => {
    if (trustedUsage && usagePath && begins(path, usagePath)) {
      const relative = path.slice(usagePath.length).map((part) => typeof part === 'string' ? originalKey(part) : part);
      let usageField: Label['usageField'] = 'other';
      if (relative[0] === 'input_tokens_details') usageField = relative[1] === 'cache_write_tokens_details'
        ? relative.length > 2 ? 'cache-write-ttl' : 'cache-write-details' : 'input-details';
      if (relative[0] === 'output_tokens_details') usageField = 'output-details';
      return { area: 'known-usage-counter', usageField, usageShape: shape(at(usage!, relative)) };
    }
    if (responsePath && begins(path, responsePath)) {
      const relative = path.slice(responsePath.length);
      if (relative[0] === 'instructions') return label('instructions');
      if (relative[0] === 'text' && relative[1] === 'format') return label('schema');
      if (relative[0] === 'metadata') return label('metadata');
      if (relative[0] === 'output' && typeof relative[1] === 'number') {
        const item = [...responsePath, 'output', relative[1]];
        if (at(original, [...item, 'type']) === 'message' && at(original, [...item, 'role']) === 'assistant'
          && relative[2] === 'content' && typeof relative[3] === 'number' && relative[4] === 'text'
          && at(original, [...item, 'content', relative[3], 'type']) === 'output_text') return label('output-text');
        if (at(original, [...item, 'type']) === 'reasoning' && relative[2] === 'summary'
          && typeof relative[3] === 'number' && relative[4] === 'text') return label('reasoning-text');
      }
    }
    if (origin === 'sse' && at(original, ['type']) === at(redacted, ['type'])) {
      const event = at(original, ['type']);
      if (['response.output_text.delta', 'response.output_text.done'].includes(String(event)) && ['delta', 'text'].includes(String(path[0]))) return label('output-text');
      if (['response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done'].includes(String(event))
        && ['delta', 'text'].includes(String(path[0]))) return label('reasoning-text');
      if (['response.content_part.added', 'response.content_part.done'].includes(String(event))
        && path[0] === 'part' && path[1] === 'text' && at(original, ['part', 'type']) === 'output_text') return label('output-text');
      if (['response.reasoning_summary_part.added', 'response.reasoning_summary_part.done'].includes(String(event))
        && path[0] === 'part' && path[1] === 'text') return label('reasoning-text');
      if (['response.output_item.added', 'response.output_item.done'].includes(String(event)) && path[0] === 'item') {
        if (at(original, ['item', 'type']) === 'message' && at(original, ['item', 'role']) === 'assistant'
          && path[1] === 'content' && typeof path[2] === 'number' && path[3] === 'text'
          && at(original, ['item', 'content', path[2], 'type']) === 'output_text') return label('output-text');
        if (at(original, ['item', 'type']) === 'reasoning' && path[1] === 'summary'
          && typeof path[2] === 'number' && path[3] === 'text') return label('reasoning-text');
      }
    }
    return label('other');
  };
};

interface Span { start: number; end: number; label: Label; path: Path; kind: 'property' | 'value' }
interface PropertySpan { start: number; keyEnd: number; end: number; path: Path }
const serialize = (value: Json, classify: (path: Path) => Label): { text: string; spans: Span[]; properties: PropertySpan[] } => {
  const parts: string[] = []; const spans: Span[] = []; const properties: PropertySpan[] = []; let offset = 0;
  const add = (text: string): void => { offset += text.length; if (offset > 524288) throw new Error(); parts.push(text); };
  const visit = (current: Json, path: Path): void => {
    const start = offset;
    if (Array.isArray(current)) {
      add('['); current.forEach((child, index) => { if (index) add(','); visit(child, [...path, index]); }); add(']');
    } else if (plain(current)) {
      const keys = Object.keys(Object.fromEntries(Object.keys(current).sort().map((key) => [key, null])));
      add('{'); keys.forEach((key, index) => {
        if (index) add(','); const propertyStart = offset; const childPath = [...path, key];
        add(JSON.stringify(key)); const keyEnd = offset - 1; add(':'); visit(current[key]!, childPath);
        spans.push({ start: propertyStart, end: offset, label: classify(childPath), path: childPath, kind: 'property' });
        properties.push({ start: propertyStart + 1, keyEnd, end: offset, path: childPath });
      }); add('}');
    } else add(JSON.stringify(current));
    spans.push({ start, end: offset, label: classify(path), path, kind: 'value' });
  };
  visit(value, []); return { text: parts.join(''), spans, properties };
};
const unique = <T extends string>(values: T[], fallback: T, multiple: T): T => {
  const choices = [...new Set(values)]; return choices.length === 1 ? choices[0]! : choices.length ? multiple : fallback;
};

/** Classify actual matches in the exact predicate string; no match text, field names or offsets escape. */
export const classifyReadonlyLiveSensitiveContent = (input: {
  original: unknown; redacted: unknown; canonical: string; origin: 'response' | 'sse';
}): ReadonlyLiveSensitiveDiagnostic => {
  try {
    if (!input || typeof input !== 'object') return other();
    const expected = ['original', 'redacted', 'canonical', 'origin']; const keys = Reflect.ownKeys(input);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) return other();
    const descriptors = expected.map((key) => Object.getOwnPropertyDescriptor(input, key));
    if (descriptors.some((field) => !field || !Object.hasOwn(field, 'value'))) return other();
    const [originalValue, redactedValue, canonical, origin] = descriptors.map((field) => field!.value) as [unknown, unknown, unknown, unknown];
    if ((origin !== 'response' && origin !== 'sse') || typeof canonical !== 'string' || canonical.length > 524288) return other();
    const original = snapshot(originalValue); const redacted = snapshot(redactedValue);
    const view = serialize(redacted, labeler(original, redacted, origin));
    if (view.text !== canonical) return other();
    const matchedPatterns: SensitivePatternKind[] = []; const matches: Label[] = [];
    for (const { kind, pattern } of getSensitivePatternDefinitions()) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(canonical))) {
        if (matches.length >= 128) return other();
        const end = match.index + match[0].length;
        let selected: Span | null = null;
        for (const span of view.spans) if (span.start <= match.index && span.end >= end
          && (!selected || span.end - span.start < selected.end - selected.start)) selected = span;
        matchedPatterns.push(kind); matches.push(selected?.label ?? label('other'));
        if (match[0].length === 0) pattern.lastIndex++;
      }
    }
    const result: ReadonlyLiveSensitiveDiagnostic = { pattern: unique<ReadonlyLiveSensitiveDiagnostic['pattern']>(matchedPatterns, 'other', 'multiple'),
      area: unique<Label['area']>(matches.map((match) => match.area), 'other', 'multiple'), usageField: 'not-applicable', usageShape: 'not-applicable' };
    if (result.area === 'known-usage-counter') {
      result.usageField = unique<Label['usageField']>(matches.map((match) => match.usageField), 'other', 'multiple');
      result.usageShape = unique<Label['usageShape']>(matches.map((match) => match.usageShape), 'other', 'multiple');
    }
    return copyReadonlyLiveSensitiveDiagnostic(result) ?? other();
  } catch { return other(); }
};

/** Persist only the exact enum shape, never extra properties, inherited values or accessors. */
export const copyReadonlyLiveSensitiveDiagnostic = (value: unknown): ReadonlyLiveSensitiveDiagnostic | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value); const expected = ['pattern', 'area', 'usageField', 'usageShape'];
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) return null;
    const read = (key: string): unknown => { const field = Object.getOwnPropertyDescriptor(value, key); return field && Object.hasOwn(field, 'value') ? field.value : undefined; };
    const pattern = read('pattern') as ReadonlyLiveSensitiveDiagnostic['pattern']; const area = read('area') as ReadonlyLiveSensitiveDiagnostic['area'];
    const usageField = read('usageField') as ReadonlyLiveSensitiveDiagnostic['usageField']; const usageShape = read('usageShape') as ReadonlyLiveSensitiveDiagnostic['usageShape'];
    if (!patterns.includes(pattern) || !areas.includes(area) || !fields.includes(usageField) || !shapes.includes(usageShape)) return null;
    if (area === 'known-usage-counter') {
      if (pattern !== 'credential-assignment' || ['not-applicable'].includes(usageField) || ['other', 'not-applicable'].includes(usageShape)) return null;
    } else if (usageField !== 'not-applicable' || usageShape !== 'not-applicable') return null;
    if (pattern === 'other' && area !== 'other') return null;
    return { pattern, area, usageField, usageShape };
  } catch { return null; }
};

const attributionEnums = {
  event: ['direct-response', 'created', 'in-progress', 'completed', 'failed', 'incomplete', 'cancelled', 'error', 'output-text', 'reasoning-text', 'output-item', 'content-part', 'missing', 'other'],
  responseMarker: ['response', 'missing', 'null', 'other', 'not-applicable'],
  responseStatus: ['in-progress', 'completed', 'failed', 'incomplete', 'cancelled', 'queued', 'missing', 'other', 'not-applicable'],
  reason: ['attributed', 'event-gate', 'response-marker-gate', 'usage-shape', 'usage-projection', 'unmapped-property', 'text-content', 'parent-span', 'multiple', 'unresolved'],
  matchExtent: ['property', 'parent', 'text', 'multiple', 'unresolved'],
  field: ['input-tokens', 'output-tokens', 'total-tokens', 'input-details', 'output-details', 'cached-tokens', 'cache-write-tokens', 'cache-write-details', 'cache-write-ttl', 'reasoning-tokens', 'max-output-tokens', 'credential-field', 'other', 'not-property', 'multiple', 'unresolved'],
  valueType: ['null', 'integer', 'number', 'string', 'boolean', 'object', 'array', 'multiple', 'unresolved'],
  usageValidation: ['valid-known', 'missing', 'invalid-shape', 'invalid-projection', 'not-applicable'],
  providerError: ['authentication', 'permission', 'rate-limit', 'invalid-request', 'invalid-schema', 'context-limit', 'model-unavailable', 'server-error', 'none', 'other'],
  providerParameter: ['model', 'instructions', 'input', 'text-format', 'tools', 'stream', 'store', 'max-output-tokens', 'authentication', 'none', 'other'],
} as const;
export interface ReadonlyLiveSensitiveAttribution {
  event: typeof attributionEnums.event[number];
  responseMarker: typeof attributionEnums.responseMarker[number];
  responseStatus: typeof attributionEnums.responseStatus[number];
  reason: typeof attributionEnums.reason[number];
  matchExtent: typeof attributionEnums.matchExtent[number];
  field: typeof attributionEnums.field[number];
  valueType: typeof attributionEnums.valueType[number];
  usageValidation: typeof attributionEnums.usageValidation[number];
  providerError: typeof attributionEnums.providerError[number];
  providerParameter: typeof attributionEnums.providerParameter[number];
}
const unresolvedAttribution = (): ReadonlyLiveSensitiveAttribution => ({ event: 'other', responseMarker: 'not-applicable', responseStatus: 'not-applicable',
  reason: 'unresolved', matchExtent: 'unresolved', field: 'unresolved', valueType: 'unresolved', usageValidation: 'not-applicable', providerError: 'none', providerParameter: 'none' });
const eventNames: Readonly<Record<string, ReadonlyLiveSensitiveAttribution['event']>> = {
  'response.created': 'created', 'response.in_progress': 'in-progress', 'response.completed': 'completed', 'response.failed': 'failed',
  'response.incomplete': 'incomplete', 'response.cancelled': 'cancelled', error: 'error',
  'response.output_text.delta': 'output-text', 'response.output_text.done': 'output-text',
  'response.reasoning_summary_text.delta': 'reasoning-text', 'response.reasoning_summary_text.done': 'reasoning-text',
  'response.reasoning_summary_part.added': 'reasoning-text', 'response.reasoning_summary_part.done': 'reasoning-text',
  'response.output_item.added': 'output-item', 'response.output_item.done': 'output-item',
  'response.content_part.added': 'content-part', 'response.content_part.done': 'content-part',
};
const fieldNames: Readonly<Record<string, ReadonlyLiveSensitiveAttribution['field']>> = {
  input_tokens: 'input-tokens', output_tokens: 'output-tokens', total_tokens: 'total-tokens', input_tokens_details: 'input-details', output_tokens_details: 'output-details',
  cached_tokens: 'cached-tokens', cache_write_tokens: 'cache-write-tokens', cache_write_tokens_details: 'cache-write-details',
  ttl_12h_tokens: 'cache-write-ttl', ttl_30m_tokens: 'cache-write-ttl', reasoning_tokens: 'reasoning-tokens', max_output_tokens: 'max-output-tokens',
  api_key: 'credential-field', 'api-key': 'credential-field', access_token: 'credential-field', 'access-token': 'credential-field',
  refresh_token: 'credential-field', 'refresh-token': 'credential-field', private_key: 'credential-field', 'private-key': 'credential-field',
  password: 'credential-field', secret: 'credential-field', token: 'credential-field',
};
const lookup = <T extends string>(map: Readonly<Record<string, T>>, value: Json | undefined, fallback: T): T =>
  typeof value === 'string' && Object.hasOwn(map, value) ? map[value]! : fallback;
// Fixed code meanings only; this does not assert that a backend supports or will emit any code.
// Sources: Responses streaming-events / methods/retrieve; shared error-codes; Agents API errors.
const errorNames: Readonly<Record<string, ReadonlyLiveSensitiveAttribution['providerError']>> = {
  unauthorized: 'authentication', authentication_error: 'authentication', forbidden: 'permission',
  rate_limit_exceeded: 'rate-limit', rate_limit_error: 'rate-limit', slow_down: 'rate-limit',
  invalid_prompt: 'invalid-request', invalid_request_error: 'invalid-request', invalid_request: 'invalid-request',
  context_length_exceeded: 'context-limit', model_not_found: 'model-unavailable',
  server_error: 'server-error', internal_error: 'server-error', service_unavailable_error: 'server-error', server_is_overloaded: 'server-error',
};
const parameterNames: Readonly<Record<string, ReadonlyLiveSensitiveAttribution['providerParameter']>> = {
  model: 'model', instructions: 'instructions', input: 'input', 'text.format': 'text-format', 'text.format.schema': 'text-format',
  tools: 'tools', stream: 'stream', store: 'store', max_output_tokens: 'max-output-tokens',
};
const responseEvents = ['response.created', 'response.in_progress', 'response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'];
const providerFields = (original: Json, origin: 'response' | 'sse'): Pick<ReadonlyLiveSensitiveAttribution, 'providerError' | 'providerParameter'> => {
  const rootEvent = origin === 'sse' && at(original, ['type']) === 'error';
  const event = at(original, ['type']);
  const response = origin === 'response' ? original : typeof event === 'string' && responseEvents.includes(event) ? at(original, ['response']) : undefined;
  const error = rootEvent ? original : plain(response) ? response.error : undefined;
  if (error === undefined || error === null) return { providerError: 'none', providerParameter: 'none' };
  if (!plain(error)) return { providerError: 'other', providerParameter: 'other' };
  const code = lookup(errorNames, error.code, 'other');
  const type = rootEvent ? 'other' : lookup(errorNames, error.type, 'other');
  return { providerError: code !== 'other' ? code : type,
    providerParameter: error.param === undefined || error.param === null ? 'none' : lookup(parameterNames, error.param, 'other') };
};
type MatchAttribution = Pick<ReadonlyLiveSensitiveAttribution, 'reason' | 'matchExtent' | 'field' | 'valueType'>;
const valueType = (value: Json | undefined): MatchAttribution['valueType'] => value === null ? 'null' : Array.isArray(value) ? 'array'
  : typeof value === 'number' ? Number.isSafeInteger(value) ? 'integer' : 'number'
    : typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : plain(value) ? 'object' : 'unresolved';
const narrowest = (spans: Span[], start: number, end: number, kind?: Span['kind']): Span | null => {
  let selected: Span | null = null;
  for (const span of spans) if ((!kind || span.kind === kind) && span.start <= start && span.end >= end
    && (!selected || span.end - span.start < selected.end - selected.start)) selected = span;
  return selected;
};

/** Additional observations use the same exact predicate text; field/type describe the match start, never a guessed child. */
export const classifyReadonlyLiveSensitiveAttribution = (input: {
  original: unknown; redacted: unknown; canonical: string; origin: 'response' | 'sse';
}): ReadonlyLiveSensitiveAttribution => {
  try {
    if (!input || typeof input !== 'object') return unresolvedAttribution();
    const expected = ['original', 'redacted', 'canonical', 'origin']; const keys = Reflect.ownKeys(input);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) return unresolvedAttribution();
    const descriptors = expected.map((key) => Object.getOwnPropertyDescriptor(input, key));
    if (descriptors.some((field) => !field || !Object.hasOwn(field, 'value'))) return unresolvedAttribution();
    const [originalValue, redactedValue, canonical, origin] = descriptors.map((field) => field!.value) as [unknown, unknown, unknown, unknown];
    if ((origin !== 'response' && origin !== 'sse') || typeof canonical !== 'string' || canonical.length > 524288) return unresolvedAttribution();
    const original = snapshot(originalValue); const redacted = snapshot(redactedValue);
    const view = serialize(redacted, labeler(original, redacted, origin));
    if (view.text !== canonical) return unresolvedAttribution();
    const eventValue = at(original, ['type']);
    const event: ReadonlyLiveSensitiveAttribution['event'] = origin === 'response' ? 'direct-response'
      : eventValue === undefined ? 'missing' : lookup(eventNames, eventValue, 'other');
    const responsePath: Path = origin === 'response' ? [] : ['response'];
    const responseEvent = origin === 'response' || (typeof eventValue === 'string' && responseEvents.includes(eventValue));
    const response = responseEvent ? at(original, responsePath) : undefined; const projectedResponse = responseEvent ? at(redacted, responsePath) : undefined;
    const marker = plain(response) ? response.object : undefined;
    const responseMarker: ReadonlyLiveSensitiveAttribution['responseMarker'] = !plain(response) ? 'not-applicable'
      : marker === undefined ? 'missing' : marker === null ? 'null' : marker === 'response' ? 'response' : 'other';
    const status = plain(response) ? response.status : undefined;
    const responseStatus: ReadonlyLiveSensitiveAttribution['responseStatus'] = !plain(response) ? 'not-applicable'
      : status === undefined ? 'missing' : status === 'in_progress' ? 'in-progress'
        : typeof status === 'string' && ['completed', 'failed', 'incomplete', 'cancelled', 'queued'].includes(status) ? status as ReadonlyLiveSensitiveAttribution['responseStatus'] : 'other';
    const usage = plain(response) ? response.usage : undefined;
    const usageValidation: ReadonlyLiveSensitiveAttribution['usageValidation'] = !plain(response) ? 'not-applicable'
      : usage === undefined ? 'missing' : !knownUsage(usage) ? 'invalid-shape'
        : !counterProjection(usage, plain(projectedResponse) ? projectedResponse.usage : undefined) ? 'invalid-projection' : 'valid-known';
    const lifecycle = origin === 'response' || ['created', 'in-progress', 'completed'].includes(event);
    const eventGate = origin === 'sse' && (eventValue !== at(redacted, ['type'])
      || !['created', 'in-progress', 'completed', 'output-text', 'reasoning-text', 'output-item', 'content-part'].includes(event));
    const markerGate = lifecycle && (responseMarker !== 'response' || !plain(projectedResponse) || projectedResponse.object !== 'response');
    const matches: { path: string; result: MatchAttribution }[] = [];
    for (const { pattern } of getSensitivePatternDefinitions()) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(canonical))) {
        if (matches.length >= 128) return unresolvedAttribution();
        const end = match.index + match[0].length; const selected = narrowest(view.spans, match.index, end);
        const property = view.properties.find((span) => span.start <= match!.index && span.keyEnd > match!.index);
        const value = property ? null : narrowest(view.spans, match.index, match.index + 1, 'value');
        const path = property?.path ?? value?.path;
        const type = valueType(path ? at(redacted, path) : undefined);
        const matchExtent: MatchAttribution['matchExtent'] = property ? end > property.end ? 'parent' : 'property' : type === 'string' ? 'text' : 'unresolved';
        const key = property?.path.at(-1);
        const field: MatchAttribution['field'] = property ? lookup(fieldNames, typeof key === 'string' ? originalKey(key) : undefined, 'other') : type === 'string' ? 'not-property' : 'unresolved';
        const inUsage = path && begins(path, [...responsePath, 'usage']);
        const reason: MatchAttribution['reason'] = selected && selected.label.area !== 'other' ? 'attributed'
          : matchExtent === 'text' ? 'text-content' : eventGate ? 'event-gate' : markerGate ? 'response-marker-gate'
            : inUsage && usageValidation === 'invalid-shape' ? 'usage-shape' : inUsage && usageValidation === 'invalid-projection' ? 'usage-projection'
              : matchExtent === 'parent' ? 'parent-span' : property ? 'unmapped-property' : 'unresolved';
        if (!path || matchExtent === 'unresolved' || type === 'unresolved') return unresolvedAttribution();
        matches.push({ path: JSON.stringify(path), result: { reason, matchExtent, field, valueType: type } });
        if (match[0].length === 0) pattern.lastIndex++;
      }
    }
    if (!matches.length) return unresolvedAttribution();
    const first = matches[0]!;
    const different = matches.some((match) => match.path !== first.path || JSON.stringify(match.result) !== JSON.stringify(first.result));
    const result: ReadonlyLiveSensitiveAttribution = { event, responseMarker, responseStatus, usageValidation, ...providerFields(original, origin),
      ...(different ? { reason: 'multiple', matchExtent: 'multiple', field: 'multiple', valueType: 'multiple' } as const : first.result) };
    return copyReadonlyLiveSensitiveAttribution(result) ?? unresolvedAttribution();
  } catch { return unresolvedAttribution(); }
};

/** Validate only data properties and exact enum combinations before persistence; never return caller-owned data. */
export const copyReadonlyLiveSensitiveAttribution = (value: unknown): ReadonlyLiveSensitiveAttribution | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value); const expected = Object.keys(attributionEnums);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) return null;
    const values: [string, string][] = [];
    for (const key of expected as (keyof ReadonlyLiveSensitiveAttribution)[]) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !Object.hasOwn(property, 'value') || !(attributionEnums[key] as readonly unknown[]).includes(property.value)) return null;
      values.push([key, property.value as string]);
    }
    const result = Object.fromEntries(values) as unknown as ReadonlyLiveSensitiveAttribution;
    const grouped = [result.reason, result.matchExtent, result.field, result.valueType];
    if (grouped.includes('multiple') && !grouped.every((value) => value === 'multiple')) return null;
    if (grouped.includes('unresolved') && !grouped.every((value) => value === 'unresolved')) return null;
    if (result.matchExtent === 'text' && (result.field !== 'not-property' || result.valueType !== 'string' || !['attributed', 'text-content'].includes(result.reason))) return null;
    if (result.field === 'not-property' && result.matchExtent !== 'text') return null;
    if (result.reason === 'text-content' && result.matchExtent !== 'text') return null;
    if (result.reason === 'parent-span' && result.matchExtent !== 'parent') return null;
    if (result.responseMarker === 'not-applicable' && (result.responseStatus !== 'not-applicable' || result.usageValidation !== 'not-applicable')) return null;
    if (result.responseMarker !== 'not-applicable' && result.responseStatus === 'not-applicable') return null;
    if (result.reason === 'usage-shape' && result.usageValidation !== 'invalid-shape') return null;
    if (result.reason === 'usage-projection' && result.usageValidation !== 'invalid-projection') return null;
    if (result.providerError === 'none' && result.providerParameter !== 'none') return null;
    return result;
  } catch { return null; }
};

const matchRegions = ['usage', 'reasoning-settings', 'schema', 'metadata', 'output-text', 'reasoning-text', 'instructions', 'provider-error', 'prompt-cache-diagnostics', 'tool-usage', 'response-metadata', 'event-root', 'other'] as const;
const matchValueTypes = ['null', 'nonnegative-integer', 'negative-integer', 'number', 'string', 'boolean', 'object', 'array'] as const;
const additionalMatchFields = ['cache-missed-tokens', 'comparison-reusable-tokens', 'image-tokens', 'text-tokens', 'cached-image-tokens', 'cached-text-tokens', 'cached-details'] as const;
export interface ReadonlyLiveSensitiveMatch {
  pattern: SensitivePatternKind;
  region: typeof matchRegions[number];
  reason: Exclude<ReadonlyLiveSensitiveAttribution['reason'], 'multiple' | 'unresolved'>;
  matchExtent: 'property' | 'parent' | 'text';
  field: Exclude<ReadonlyLiveSensitiveAttribution['field'], 'multiple' | 'unresolved'> | typeof additionalMatchFields[number];
  valueType: typeof matchValueTypes[number];
  count: number;
}
export interface ReadonlyLiveSensitiveMatches {
  entries: ReadonlyLiveSensitiveMatch[];
  observedMatches: number;
  overflow: boolean;
}
type MatchTuple = Omit<ReadonlyLiveSensitiveMatch, 'count'>;
// Additional official response metadata names are observations only, never newly accepted protocol fields.
const matchFieldNames: Readonly<Record<string, MatchTuple['field'] | 'multiple' | 'unresolved'>> = { ...fieldNames,
  cache_missed_tokens: 'cache-missed-tokens', comparison_reusable_tokens: 'comparison-reusable-tokens',
  image_tokens: 'image-tokens', text_tokens: 'text-tokens', cached_image_tokens: 'cached-image-tokens', cached_text_tokens: 'cached-text-tokens', cached_tokens_details: 'cached-details',
};
const matchRegion = (original: Json, redacted: Json, origin: 'response' | 'sse', path: Path): MatchTuple['region'] => {
  const event = at(original, ['type']);
  if (origin === 'sse' && event === 'error') return 'provider-error';
  const responsePath: Path | null = origin === 'response' ? [] : typeof event === 'string' && responseEvents.includes(event) ? ['response'] : null;
  if (responsePath && begins(path, responsePath) && plain(at(original, responsePath))) {
    const relative = path.slice(responsePath.length);
    if (relative[0] === 'usage') return 'usage';
    if (relative[0] === 'prompt_cache_diagnostics') return 'prompt-cache-diagnostics';
    if (relative[0] === 'tool_usage') return 'tool-usage';
    if (relative[0] === 'reasoning') return 'reasoning-settings';
    if (relative[0] === 'text' && relative[1] === 'format') return 'schema';
    if (relative[0] === 'metadata') return 'metadata';
    if (relative[0] === 'instructions') return 'instructions';
    if (relative[0] === 'error') return 'provider-error';
    const area = labeler(original, redacted, origin)(path).area;
    return area === 'output-text' || area === 'reasoning-text' ? area : 'response-metadata';
  }
  const area = labeler(original, redacted, origin)(path).area;
  return area === 'output-text' || area === 'reasoning-text' ? area : origin === 'sse' && path.length === 1 ? 'event-root' : 'other';
};

/** Counts are frequencies of fixed tuples, not locations: distinct paths may share a tuple. */
export const classifyReadonlyLiveSensitiveMatches = (input: {
  original: unknown; redacted: unknown; canonical: string; origin: 'response' | 'sse';
}): ReadonlyLiveSensitiveMatches | null => {
  try {
    if (!input || typeof input !== 'object') return null;
    const expected = ['original', 'redacted', 'canonical', 'origin']; const keys = Reflect.ownKeys(input);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) return null;
    const descriptors = expected.map((key) => Object.getOwnPropertyDescriptor(input, key));
    if (descriptors.some((field) => !field || !Object.hasOwn(field, 'value'))) return null;
    const [originalValue, redactedValue, canonical, origin] = descriptors.map((field) => field!.value) as [unknown, unknown, unknown, unknown];
    if ((origin !== 'response' && origin !== 'sse') || typeof canonical !== 'string' || canonical.length > 524288) return null;
    const original = snapshot(originalValue); const redacted = snapshot(redactedValue);
    const view = serialize(redacted, labeler(original, redacted, origin));
    if (view.text !== canonical) return null;
    const eventValue = at(original, ['type']);
    const event = origin === 'response' ? 'direct-response' : lookup(eventNames, eventValue, 'other');
    const responsePath: Path = origin === 'response' ? [] : ['response'];
    const responseEvent = origin === 'response' || (typeof eventValue === 'string' && responseEvents.includes(eventValue));
    const response = responseEvent ? at(original, responsePath) : undefined; const projected = responseEvent ? at(redacted, responsePath) : undefined;
    const usage = plain(response) ? response.usage : undefined;
    const validUsage = knownUsage(usage); const validProjection = validUsage && counterProjection(usage, plain(projected) ? projected.usage : undefined);
    const lifecycle = origin === 'response' || ['created', 'in-progress', 'completed'].includes(event);
    const eventGate = origin === 'sse' && (eventValue !== at(redacted, ['type'])
      || !['created', 'in-progress', 'completed', 'output-text', 'reasoning-text', 'output-item', 'content-part'].includes(event));
    const markerGate = lifecycle && (!plain(response) || response.object !== 'response' || !plain(projected) || projected.object !== 'response');
    const entries = new Map<string, ReadonlyLiveSensitiveMatch>(); let observedMatches = 0; let overflow = false;
    matching: for (const { kind, pattern } of getSensitivePatternDefinitions()) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(canonical))) {
        if (observedMatches >= 128) { overflow = true; break matching; }
        const end = match.index + match[0].length; const selected = narrowest(view.spans, match.index, end);
        const property = view.properties.find((span) => span.start <= match!.index && span.keyEnd > match!.index);
        const value = property ? null : narrowest(view.spans, match.index, match.index + 1, 'value');
        const path = property?.path ?? value?.path; if (!path) return null;
        const current = at(redacted, path); const type = valueType(current);
        if (type === 'unresolved' || type === 'multiple') return null;
        const matchExtent = property ? end > property.end ? 'parent' : 'property' : type === 'string' ? 'text' : null;
        if (!matchExtent) return null;
        const key = property?.path.at(-1);
        const field = property ? lookup(matchFieldNames, typeof key === 'string' ? originalKey(key) : undefined, 'other') : 'not-property';
        if (field === 'multiple' || field === 'unresolved') return null;
        const inUsage = responseEvent && begins(path, [...responsePath, 'usage']);
        const reason: MatchTuple['reason'] = selected && selected.label.area !== 'other' ? 'attributed'
          : matchExtent === 'text' ? 'text-content' : eventGate ? 'event-gate' : markerGate ? 'response-marker-gate'
            : inUsage && !validUsage ? 'usage-shape' : inUsage && !validProjection ? 'usage-projection'
              : matchExtent === 'parent' ? 'parent-span' : 'unmapped-property';
        const tuple: MatchTuple = { pattern: kind, region: matchRegion(original, redacted, origin, path), reason, matchExtent, field,
          valueType: type === 'integer' ? (current as number) < 0 ? 'negative-integer' : 'nonnegative-integer' : type };
        const identity = JSON.stringify(tuple); const existing = entries.get(identity);
        if (!existing && entries.size >= 32) { overflow = true; break matching; }
        if (existing) existing.count++; else entries.set(identity, { ...tuple, count: 1 });
        observedMatches++;
        if (match[0].length === 0) pattern.lastIndex++;
      }
    }
    return copyReadonlyLiveSensitiveMatches({ entries: [...entries.values()], observedMatches, overflow });
  } catch { return null; }
};

/** Copy a bounded enum histogram; neither array accessors nor entry properties are evaluated. */
export const copyReadonlyLiveSensitiveMatches = (value: unknown): ReadonlyLiveSensitiveMatches | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value); const expected = ['entries', 'observedMatches', 'overflow'];
    if (keys.length !== 3 || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) return null;
    const read = (object: object, key: string): unknown => { const field = Object.getOwnPropertyDescriptor(object, key); return field && Object.hasOwn(field, 'value') ? field.value : undefined; };
    const entries = read(value, 'entries'); const observedMatches = read(value, 'observedMatches'); const overflow = read(value, 'overflow');
    if (!Array.isArray(entries) || !Number.isSafeInteger(observedMatches) || (observedMatches as number) < 0 || (observedMatches as number) > 128 || typeof overflow !== 'boolean') return null;
    const length = read(entries, 'length');
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 32 || Reflect.ownKeys(entries).length !== (length as number) + 1) return null;
    const result: ReadonlyLiveSensitiveMatch[] = []; const seen = new Set<string>(); let count = 0;
    const fields = ['pattern', 'region', 'reason', 'matchExtent', 'field', 'valueType', 'count'];
    for (let index = 0; index < (length as number); index++) {
      const item = read(entries, String(index)); if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const itemKeys = Reflect.ownKeys(item);
      if (itemKeys.length !== fields.length || itemKeys.some((key) => typeof key !== 'string' || !fields.includes(key))) return null;
      const values = fields.map((key) => read(item, key)); const [pattern, region, reason, matchExtent, field, type, occurrences] = values;
      if (!['private-key-block', 'provider-key-prefix', 'bearer-token', 'credential-assignment'].includes(pattern as string)
        || !(matchRegions as readonly unknown[]).includes(region) || !attributionEnums.reason.includes(reason as ReadonlyLiveSensitiveAttribution['reason'])
        || ['multiple', 'unresolved'].includes(reason as string) || !['property', 'parent', 'text'].includes(matchExtent as string)
        || (!(attributionEnums.field as readonly unknown[]).includes(field) && !(additionalMatchFields as readonly unknown[]).includes(field)) || ['multiple', 'unresolved'].includes(field as string)
        || !(matchValueTypes as readonly unknown[]).includes(type) || !Number.isSafeInteger(occurrences) || (occurrences as number) < 1 || (occurrences as number) > 128) return null;
      if (matchExtent === 'text' && (field !== 'not-property' || type !== 'string' || !['attributed', 'text-content'].includes(reason as string))) return null;
      if (field === 'not-property' && matchExtent !== 'text') return null;
      if (reason === 'text-content' && matchExtent !== 'text') return null;
      if (reason === 'parent-span' && matchExtent !== 'parent') return null;
      if (['usage-shape', 'usage-projection'].includes(reason as string) && region !== 'usage') return null;
      const identity = JSON.stringify(values.slice(0, -1)); if (seen.has(identity)) return null; seen.add(identity);
      count += occurrences as number; if (count > 128) return null;
      result.push(Object.fromEntries(fields.map((key, position) => [key, values[position]])) as unknown as ReadonlyLiveSensitiveMatch);
    }
    if (count !== observedMatches || (overflow && count < 128 && result.length !== 32)) return null;
    const identity = (entry: ReadonlyLiveSensitiveMatch): string => JSON.stringify(fields.slice(0, -1).map((key) => entry[key as keyof ReadonlyLiveSensitiveMatch]));
    result.sort((left, right) => identity(left) < identity(right) ? -1 : identity(left) > identity(right) ? 1 : 0);
    return { entries: result, observedMatches: count, overflow };
  } catch { return null; }
};
