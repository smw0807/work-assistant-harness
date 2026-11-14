const counts = ['receivedBytes', 'bufferedBytes', 'inspectedBytes', 'chunks', 'maxChunkBytes',
  'completedFrames', 'maxFrameBytes', 'partialFrameBytes'] as const;
const terminations = ['eof', 'response-limit', 'frame-limit', 'header-limit', 'invalid-http', 'invalid-utf8',
  'invalid-sse', 'invalid-json', 'credential-reflection', 'reflection-state-limit', 'cancelled', 'timeout',
  'cleanup-uncertain', 'invalid-response', 'invalid-credential', 'invalid-options'] as const;
const failedLimits = ['none', 'response-bytes', 'frame', 'headers', 'credential-prefix-states'] as const;
export interface ReadonlyRelayReceptionDiagnostic {
  readonly receivedBytes: number;
  readonly bufferedBytes: number;
  /** Wire-counter prefix only; this does not attest JSON, reflection or frame validation. */
  readonly inspectedBytes: number;
  readonly chunks: number;
  readonly maxChunkBytes: number;
  readonly completedFrames: number;
  readonly maxFrameBytes: number;
  readonly partialFrameBytes: number;
  readonly eof: boolean;
  readonly termination: typeof terminations[number];
  readonly failedLimit: typeof failedLimits[number];
}

/** Fixed counters only: no untrusted properties, error payloads or getters enter a report. */
export const copyReadonlyRelayReceptionDiagnostic = (value: unknown): ReadonlyRelayReceptionDiagnostic | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const names = [...counts, 'eof', 'termination', 'failedLimit']; const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || names.some((key) => !keys.includes(key))) return null;
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
      fields[key] = descriptor.value;
    }
    if (counts.some((key) => !Number.isSafeInteger(fields[key]) || (fields[key] as number) < 0)
      || typeof fields.eof !== 'boolean' || !(terminations as readonly unknown[]).includes(fields.termination)
      || !(failedLimits as readonly unknown[]).includes(fields.failedLimit)) return null;
    const result = fields as unknown as ReadonlyRelayReceptionDiagnostic;
    if (result.bufferedBytes > result.inspectedBytes || result.inspectedBytes > result.receivedBytes
      || result.inspectedBytes > 4194304 || result.maxChunkBytes > result.receivedBytes
      || result.maxFrameBytes > result.inspectedBytes || result.partialFrameBytes > result.maxFrameBytes
      || result.completedFrames > result.inspectedBytes
      || (result.chunks === 0 && (result.receivedBytes !== 0 || result.maxChunkBytes !== 0))
      || (result.maxChunkBytes === 0 && result.receivedBytes !== 0)
      || (result.maxChunkBytes > 0 && Math.ceil(result.receivedBytes / result.maxChunkBytes) > result.chunks)
      || (result.termination === 'eof' && (!result.eof || result.failedLimit !== 'none'))
      || (result.failedLimit === 'response-bytes' && (result.eof
        || result.receivedBytes <= 262144 || result.receivedBytes <= result.bufferedBytes))) return null;
    const expectedLimit = result.termination === 'response-limit' ? 'response-bytes' : result.termination === 'frame-limit' ? 'frame'
      : result.termination === 'header-limit' ? 'headers' : result.termination === 'reflection-state-limit' ? 'credential-prefix-states' : 'none';
    if (result.termination !== 'cleanup-uncertain' && result.failedLimit !== expectedLimit) return null;
    return Object.freeze({ ...result });
  } catch { return null; }
};
