const fieldLabels = {
  type: 'type', sequence_number: 'sequence-number', response: 'response', response_id: 'response-id',
  output_index: 'output-index', item: 'item', item_id: 'item-id', content_index: 'content-index',
  part: 'part', delta: 'delta', text: 'text', summary_index: 'summary-index', obfuscation: 'obfuscation',
  logprobs: 'logprobs', event_id: 'event-id', id: 'id', created_at: 'created-at',
  stream_id: 'stream-id', object: 'object', model: 'model', status: 'status', usage: 'usage', tools: 'tools',
} as const;
type Field = typeof fieldLabels[keyof typeof fieldLabels];
const fields: readonly string[] = Object.values(fieldLabels);
const envelopeNames = ['type', 'sequence_number', 'response', 'response_id', 'output_index', 'item', 'item_id',
  'content_index', 'part', 'delta', 'text', 'summary_index', 'obfuscation', 'logprobs'] as const;
const missingFields: readonly string[] = envelopeNames.map((name) => fieldLabels[name]);
const valueTypes = ['null', 'boolean', 'nonnegative-integer', 'negative-integer', 'number', 'string', 'array', 'object'] as const;
type ValueType = typeof valueTypes[number];
interface UnexpectedField { field: Field | 'other'; valueType: ValueType; count: number }
export interface ReadonlyLiveSseEnvelopeDiagnostic {
  missing: Field[];
  unexpected: UnexpectedField[];
  observedUnexpected: number;
  overflow: boolean;
}
const maxProperties = 128;
const maxEntries = 32;

/** Inspect descriptors rather than evaluating potentially untrusted getters. */
const ownData = (value: unknown): Map<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) return null;
    result.set(key, field.value);
  }
  return result;
};
const ownArray = (value: unknown, maximum: number): unknown[] | null => {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
    || length.value < 0 || length.value > maximum) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !Object.hasOwn(item, 'value') || !item.enumerable) return null;
    result.push(item.value);
  }
  return result;
};
const exact = (value: Map<string, unknown>, keys: readonly string[]): boolean =>
  value.size === keys.length && keys.every((key) => value.has(key));
const valueType = (value: unknown): ValueType | null => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return !Number.isFinite(value) ? null
    : Number.isSafeInteger(value) ? value >= 0 ? 'nonnegative-integer' : 'negative-integer' : 'number';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : null;
};
const registeredNames = (value: unknown): string[] | null => {
  const names = ownArray(value, envelopeNames.length);
  if (!names || names.some((name) => !(envelopeNames as readonly unknown[]).includes(name))
    || new Set(names).size !== names.length) return null;
  return names as string[];
};
const label = (name: string): Field | 'other' => Object.hasOwn(fieldLabels, name)
  ? fieldLabels[name as keyof typeof fieldLabels] : 'other';
const entryKey = (entry: UnexpectedField): string => `${entry.field}\0${entry.valueType}`;
const compareEntries = (left: UnexpectedField, right: UnexpectedField): number => {
  const a = entryKey(left); const b = entryKey(right); return a < b ? -1 : a > b ? 1 : 0;
};

/** Counts describe at most 128 sorted root properties; overflow marks a partial observation, never a total. */
export const classifyReadonlyLiveSseEnvelope = (value: unknown, required: readonly string[], optional: readonly string[]): ReadonlyLiveSseEnvelopeDiagnostic | null => {
  try {
    const requiredNames = registeredNames(required); const optionalNames = registeredNames(optional);
    if (!requiredNames || !optionalNames || requiredNames.some((name) => optionalNames.includes(name))) return null;
    const data = ownData(value);
    if (!data || [...data.values()].some((item) => valueType(item) === null)) return null;
    const allowed = new Set([...requiredNames, ...optionalNames]);
    const missing = requiredNames.filter((name) => !data.has(name)).map((name) => label(name) as Field).sort();
    const entries = new Map<string, UnexpectedField>();
    const names = [...data.keys()].sort(); let observedUnexpected = 0; let overflow = names.length > maxProperties;
    for (const name of names.slice(0, maxProperties)) {
      if (allowed.has(name)) continue;
      const entry: UnexpectedField = { field: label(name), valueType: valueType(data.get(name))!, count: 1 };
      const key = entryKey(entry); const previous = entries.get(key);
      if (previous) previous.count += 1;
      else {
        if (entries.size === maxEntries) { overflow = true; break; }
        entries.set(key, entry);
      }
      observedUnexpected += 1;
    }
    return { missing, unexpected: [...entries.values()].sort(compareEntries), observedUnexpected, overflow };
  } catch { return null; }
};

/** Accept only the published enums and internally consistent counts; never copy raw response material. */
export const copyReadonlyLiveSseEnvelopeDiagnostic = (value: unknown): ReadonlyLiveSseEnvelopeDiagnostic | null => {
  try {
    const data = ownData(value);
    if (!data || !exact(data, ['missing', 'unexpected', 'observedUnexpected', 'overflow'])) return null;
    const missing = ownArray(data.get('missing'), missingFields.length);
    const unexpected = ownArray(data.get('unexpected'), maxEntries);
    const observed = data.get('observedUnexpected'); const overflow = data.get('overflow');
    if (!missing || !unexpected || missing.some((field) => typeof field !== 'string' || !missingFields.includes(field))
      || new Set(missing).size !== missing.length || !Number.isSafeInteger(observed)
      || (observed as number) < 0 || (observed as number) > maxProperties || typeof overflow !== 'boolean') return null;
    const entries: UnexpectedField[] = []; const keys = new Set<string>(); const namedFields = new Set<string>();
    let countSum = 0;
    for (const raw of unexpected) {
      const entry = ownData(raw);
      if (!entry || !exact(entry, ['field', 'valueType', 'count'])) return null;
      const field = entry.get('field'); const type = entry.get('valueType'); const count = entry.get('count');
      if (typeof field !== 'string' || (!fields.includes(field) && field !== 'other')
        || !(valueTypes as readonly unknown[]).includes(type) || !Number.isSafeInteger(count)
        || (count as number) < 1 || (count as number) > maxProperties || missing.includes(field)) return null;
      // Each registered name occurs once in an object; only unknown names can aggregate.
      if (field !== 'other' && (count !== 1 || namedFields.has(field))) return null;
      const copied: UnexpectedField = { field: field as Field | 'other', valueType: type as ValueType, count: count as number };
      const key = entryKey(copied); if (keys.has(key)) return null;
      keys.add(key); namedFields.add(field); entries.push(copied); countSum += copied.count;
    }
    if (countSum !== observed || (overflow && countSum < maxProperties - envelopeNames.length && entries.length < maxEntries)) return null;
    return { missing: (missing as Field[]).sort(), unexpected: entries.sort(compareEntries), observedUnexpected: countSum, overflow };
  } catch { return null; }
};
