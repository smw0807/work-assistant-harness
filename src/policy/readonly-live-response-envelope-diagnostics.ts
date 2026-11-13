const fieldLabels = {
  id: 'id', object: 'object', status: 'status', model: 'model', output: 'output',
  created_at: 'created-at', completed_at: 'completed-at', background: 'background', error: 'error',
  incomplete_details: 'incomplete-details', instructions: 'instructions', max_output_tokens: 'max-output-tokens',
  max_tool_calls: 'max-tool-calls', parallel_tool_calls: 'parallel-tool-calls', previous_response_id: 'previous-response-id',
  prompt_cache_key: 'prompt-cache-key', prompt_cache_retention: 'prompt-cache-retention', reasoning: 'reasoning',
  safety_identifier: 'safety-identifier', service_tier: 'service-tier', store: 'store', temperature: 'temperature',
  text: 'text', tool_choice: 'tool-choice', tools: 'tools', top_logprobs: 'top-logprobs', top_p: 'top-p',
  truncation: 'truncation', usage: 'usage', user: 'user', metadata: 'metadata', access_programs: 'access-programs',
  tool_usage: 'tool-usage', conversation: 'conversation', prompt_cache_diagnostics: 'prompt-cache-diagnostics',
  max_completion_tokens: 'max-completion-tokens', request_id: 'request-id', stream_id: 'stream-id',
  system_fingerprint: 'system-fingerprint', routing: 'routing', prompt_cache_status: 'prompt-cache-status',
} as const;
type Field = typeof fieldLabels[keyof typeof fieldLabels];
const fields: readonly string[] = Object.values(fieldLabels);
const requiredNames = ['id', 'object', 'status', 'model', 'output'] as const;
const optionalNames = ['created_at', 'completed_at', 'background', 'error', 'incomplete_details', 'instructions',
  'max_output_tokens', 'max_tool_calls', 'parallel_tool_calls', 'previous_response_id', 'prompt_cache_key', 'prompt_cache_retention',
  'reasoning', 'safety_identifier', 'service_tier', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_logprobs', 'top_p',
  'truncation', 'usage', 'user', 'metadata', 'access_programs', 'tool_usage'] as const;
type MissingField = typeof requiredNames[number];
const valueTypes = ['null', 'boolean', 'nonnegative-integer', 'negative-integer', 'number', 'string', 'array', 'object'] as const;
type ValueType = typeof valueTypes[number];
interface UnexpectedField { field: Field | 'other'; valueType: ValueType; count: number }
export interface ReadonlyLiveResponseEnvelopeDiagnostic {
  missing: MissingField[];
  unexpected: UnexpectedField[];
  observedUnexpected: number;
  overflow: boolean;
}
const maxProperties = 128;
const maxEntries = 32;

/** Inspect only own data descriptors; no response getter or nested property is evaluated. */
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
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
    || length.value < 0 || length.value > maximum) return null;
  if (Reflect.ownKeys(value).length !== length.value + 1) return null;
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
const registeredNames = (value: unknown, registered: readonly string[]): string[] | null => {
  const names = ownArray(value, registered.length);
  if (!names || names.some((name) => typeof name !== 'string' || !registered.includes(name))
    || new Set(names).size !== names.length) return null;
  return names as string[];
};
const label = (name: string): Field | 'other' => Object.hasOwn(fieldLabels, name)
  ? fieldLabels[name as keyof typeof fieldLabels] : 'other';
const entryKey = (entry: UnexpectedField): string => `${entry.field}\0${entry.valueType}`;
const compareEntries = (left: UnexpectedField, right: UnexpectedField): number => {
  const a = entryKey(left); const b = entryKey(right); return a < b ? -1 : a > b ? 1 : 0;
};

/** A bounded observation of the rejected root; these labels never authorize response fields. */
export const classifyReadonlyLiveResponseEnvelope = (value: unknown, required: readonly string[], optional: readonly string[]): ReadonlyLiveResponseEnvelopeDiagnostic | null => {
  try {
    const requiredFields = registeredNames(required, requiredNames); const optionalFields = registeredNames(optional, optionalNames);
    if (!requiredFields || !optionalFields) return null;
    const data = ownData(value);
    if (!data || [...data.values()].some((item) => valueType(item) === null)) return null;
    const allowed = new Set([...requiredFields, ...optionalFields]);
    const missing = requiredFields.filter((name) => !data.has(name)).sort() as MissingField[];
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

/** Copy only fixed labels, value categories and consistent counts, without retaining input references. */
export const copyReadonlyLiveResponseEnvelopeDiagnostic = (value: unknown): ReadonlyLiveResponseEnvelopeDiagnostic | null => {
  try {
    const data = ownData(value);
    if (!data || !exact(data, ['missing', 'unexpected', 'observedUnexpected', 'overflow'])) return null;
    const missing = ownArray(data.get('missing'), requiredNames.length);
    const unexpected = ownArray(data.get('unexpected'), maxEntries);
    const observed = data.get('observedUnexpected'); const overflow = data.get('overflow');
    if (!missing || !unexpected || missing.some((field) => !(requiredNames as readonly unknown[]).includes(field))
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
      if (field !== 'other' && (count !== 1 || namedFields.has(field))) return null;
      const copied: UnexpectedField = { field: field as Field | 'other', valueType: type as ValueType, count: count as number };
      const key = entryKey(copied); if (keys.has(key)) return null;
      keys.add(key); namedFields.add(field); entries.push(copied); countSum += copied.count;
    }
    const maximumAllowed = requiredNames.length + optionalNames.length;
    if (countSum !== observed || (overflow && countSum < maxProperties - maximumAllowed && entries.length < maxEntries)) return null;
    return { missing: (missing as MissingField[]).sort(), unexpected: entries.sort(compareEntries), observedUnexpected: countSum, overflow };
  } catch { return null; }
};
