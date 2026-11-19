export interface ReadonlyRelayReflectionDiagnostic {
  readonly version: 'readonly-relay-reflection-diagnostic-v1';
  readonly scope: 'upstream-sse' | 'final-json';
  readonly match: 'raw-exact' | 'decoded-exact' | 'ordered-fragment';
  readonly credential: 'accessToken' | 'accountId';
}

/** Only fixed categories survive: no credential value, fragment, length, offset or response property name. */
export const copyReadonlyRelayReflectionDiagnostic = (value: unknown): ReadonlyRelayReflectionDiagnostic | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const names = ['version', 'scope', 'match', 'credential']; const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || names.some(key => !keys.includes(key))) return null;
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
      fields[key] = descriptor.value;
    }
    if (fields.version !== 'readonly-relay-reflection-diagnostic-v1'
      || !['upstream-sse', 'final-json'].includes(fields.scope as string)
      || !['raw-exact', 'decoded-exact', 'ordered-fragment'].includes(fields.match as string)
      || !['accessToken', 'accountId'].includes(fields.credential as string)) return null;
    return Object.freeze({ ...fields }) as unknown as ReadonlyRelayReflectionDiagnostic;
  } catch { return null; }
};
