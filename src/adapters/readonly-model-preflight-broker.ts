import { HarnessError } from '../domain/errors.js';
import type { ReadonlyModelPreflightDispatch } from '../domain/readonly-model-preflight.js';
import { assertReadonlyModelPreflightDispatch } from '../policy/readonly-model-preflight-policy.js';
import type { ReadonlyModelPreflightPort } from '../ports/readonly-model-preflight.js';

type DecodedResponse = Awaited<ReturnType<ReadonlyModelPreflightPort['transmit']>>;
interface Limits { workTimeoutMs: number; cleanupTimeoutMs: number }
const knownFailure = (error: unknown): string => {
  const codes = ['CANCELLED', 'TIMEOUT', 'RESPONSE_LIMIT', 'OUTPUT_LIMIT', 'HEADER_LIMIT', 'FRAME_LIMIT',
    'INVALID_RESPONSE', 'PROCESS_FAILED', 'LIFECYCLE_UNSAFE', 'INVALID_REQUEST'];
  if (error instanceof HarnessError && (codes.some((code) => error.code === `READONLY_MODEL_PREFLIGHT_${code}`)
    || /^READONLY_MODEL_PREFLIGHT_HTTP_[1-5]\d{2}$/u.test(error.code))) return error.code;
  return 'READONLY_MODEL_PREFLIGHT_CALL_FAILED';
};

/** 승인한 명세를 그대로 전달한다. transport 기본값과 실제 인증/네트워크 경로는 없다. */
export class ReadonlyModelPreflightBroker {
  private consumed = false;

  constructor(private readonly port: ReadonlyModelPreflightPort,
    private readonly limits: Limits = { workTimeoutMs: 55_000, cleanupTimeoutMs: 5_000 }) {
    this.assertFakePort();
    if (!limits || !Number.isSafeInteger(limits.workTimeoutMs) || limits.workTimeoutMs < 1 || limits.workTimeoutMs > 55_000
      || !Number.isSafeInteger(limits.cleanupTimeoutMs) || limits.cleanupTimeoutMs < 1 || limits.cleanupTimeoutMs > 5_000) {
      throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_LIMIT');
    }
  }

  async transmit(request: ReadonlyModelPreflightDispatch, signal: AbortSignal): Promise<DecodedResponse> {
    this.assertFakePort();
    assertReadonlyModelPreflightDispatch(request);
    if (signal.aborted) throw new HarnessError('READONLY_MODEL_PREFLIGHT_CANCELLED');
    if (this.consumed) throw new HarnessError('READONLY_MODEL_PREFLIGHT_ALREADY_DISPATCHED');
    const approved = structuredClone(request);
    approved.requestEnvelope.headers.forEach((header) => Object.freeze(header));
    Object.freeze(approved.requestEnvelope.headers); Object.freeze(approved.requestEnvelope); Object.freeze(approved);
    this.consumed = true;
    const controller = new AbortController();
    let cancellation = 'READONLY_MODEL_PREFLIGHT_CANCELLED';
    let notifyAbort: () => void = () => {};
    const aborted = new Promise<{ kind: 'abort' }>((resolve) => { notifyAbort = () => resolve({ kind: 'abort' }); });
    const abort = (): void => { controller.abort(); notifyAbort(); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { cancellation = 'READONLY_MODEL_PREFLIGHT_TIMEOUT'; abort(); }, this.limits.workTimeoutMs);
    if (signal.aborted) abort();
    type Outcome = { kind: 'result'; value: DecodedResponse } | { kind: 'error'; error: unknown };
    let transmission: Promise<DecodedResponse>;
    // Begin the fake call synchronously while store.dispatch still holds its short transaction.
    // Only the response wait belongs outside the cancellation-writer serialization boundary.
    try {
      if (controller.signal.aborted) throw new HarnessError(cancellation);
      this.assertFakePort();
      transmission = this.port.transmit(approved, controller.signal);
    } catch (error) { transmission = Promise.reject(error); }
    const settled = Promise.resolve(transmission).then((value): Outcome => ({ kind: 'result', value }),
      (error: unknown): Outcome => ({ kind: 'error', error }));
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([settled, aborted]);
      if (first.kind === 'abort' || controller.signal.aborted) {
        const cleanup = await Promise.race([settled, new Promise<{ kind: 'uncertain' }>((resolve) => {
          cleanupTimer = setTimeout(() => resolve({ kind: 'uncertain' }), this.limits.cleanupTimeoutMs);
        })]);
        if (cleanup.kind === 'uncertain' || (cleanup.kind === 'error'
          && knownFailure(cleanup.error) === 'READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE')) {
          throw new HarnessError('READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE');
        }
        throw new HarnessError(cancellation);
      }
      if (first.kind === 'error') throw new HarnessError(knownFailure(first.error));
      const result = first.value;
      if (!result || Object.keys(result).sort().join(',') !== 'responseHash,text' || typeof result.text !== 'string'
        || Buffer.from(result.text).toString('utf8') !== result.text || typeof result.responseHash !== 'string'
        || !/^[a-f0-9]{64}$/u.test(result.responseHash)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_RESPONSE');
      if (Buffer.byteLength(result.text) > 16 * 1024) throw new HarnessError('READONLY_MODEL_PREFLIGHT_OUTPUT_LIMIT');
      return result;
    } finally {
      clearTimeout(timer); if (cleanupTimer) clearTimeout(cleanupTimer);
      signal.removeEventListener('abort', abort);
    }
  }

  private assertFakePort(): void {
    if (!this.port || this.port.mode !== 'offline' || this.port.transport !== 'in-memory-fake'
      || typeof this.port.transmit !== 'function') throw new HarnessError('READONLY_MODEL_PREFLIGHT_FAKE_REQUIRED');
  }
}
