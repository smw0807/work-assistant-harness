const events = ['direct-response', 'created', 'in-progress', 'completed'] as const;
const fields = ['tool-usage', 'access-programs', 'error', 'incomplete-details', 'tools', 'tool-choice', 'store', 'background',
  'created-at', 'completed-at', 'max-output-tokens', 'max-tool-calls', 'top-logprobs', 'temperature', 'top-p',
  'parallel-tool-calls', 'instructions', 'previous-response-id', 'prompt-cache-key', 'prompt-cache-retention',
  'safety-identifier', 'service-tier', 'truncation', 'user', 'reasoning', 'reasoning-context', 'reasoning-mode',
  'metadata', 'usage', 'usage-counts', 'usage-input-details', 'usage-output-details', 'text', 'text-verbosity',
  'text-format', 'text-format-description', 'text-format-type', 'text-format-strict', 'text-format-name'] as const;
const reasons = ['shape', 'value', 'integer', 'number', 'text', 'size'] as const;
export interface ReadonlyLiveMetadataDiagnostic {
  readonly event: typeof events[number];
  readonly field: typeof fields[number];
  readonly reason: typeof reasons[number];
}

/** Only source-registered labels escape; inspecting a diagnostic never evaluates its getters. */
export const copyReadonlyLiveMetadataDiagnostic = (value: unknown): ReadonlyLiveMetadataDiagnostic | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || !['event', 'field', 'reason'].every((key) => keys.includes(key))) return null;
    const descriptors = ['event', 'field', 'reason'].map((key) => Object.getOwnPropertyDescriptor(value, key));
    if (descriptors.some((descriptor) => !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)) return null;
    const [event, field, reason] = descriptors.map((descriptor) => descriptor!.value);
    if (!(events as readonly unknown[]).includes(event) || !(fields as readonly unknown[]).includes(field)
      || !(reasons as readonly unknown[]).includes(reason)) return null;
    return Object.freeze({ event, field, reason });
  } catch { return null; }
};
