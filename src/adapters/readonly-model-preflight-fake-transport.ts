import { spawn } from 'node:child_process';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyModelPreflightDispatch } from '../domain/readonly-model-preflight.js';
import { assertReadonlyModelPreflightDispatch } from '../policy/readonly-model-preflight-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import type { ReadonlyModelPreflightPort } from '../ports/readonly-model-preflight.js';
import { readonlyModelPreflightWorkerLaunch } from './readonly-model-preflight-worker-contract.js';
import { createReadonlyModelPreflightLifecycle, type ReadonlyModelPreflightLocation } from './readonly-model-preflight-lifecycle.js';

type DecodedResponse = Awaited<ReturnType<ReadonlyModelPreflightPort['transmit']>>;

/** 메모리 HTTP 예행만 수행하는 제한 worker. 실제 인증·모델·네트워크를 연결하지 않는다. */
export class RestrictedReadonlyModelPreflightFakeTransport implements ReadonlyModelPreflightPort {
  readonly mode = 'offline' as const;
  readonly transport = 'in-memory-fake' as const;

  constructor(private readonly timeoutMs = 55_000, private readonly location?: ReadonlyModelPreflightLocation) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000) {
      throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_LIMIT');
    }
  }

  transmit(request: ReadonlyModelPreflightDispatch, signal: AbortSignal): Promise<DecodedResponse> {
    if (signal.aborted) return Promise.reject(new HarnessError('READONLY_MODEL_PREFLIGHT_CANCELLED'));
    try { assertReadonlyModelPreflightDispatch(request); }
    catch { return Promise.reject(new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_REQUEST')); }
    // IPC serialization has its own bounded framing; the approved envelope/body are not rebuilt.
    const wire = JSON.stringify(request);
    if (Buffer.byteLength(wire) > 1024 * 1024) return Promise.reject(new HarnessError('READONLY_MODEL_PREFLIGHT_REQUEST_LIMIT'));
    return new Promise((resolve, reject) => {
      const launch = readonlyModelPreflightWorkerLaunch();
      const lifecycle = this.location ? createReadonlyModelPreflightLifecycle(this.location, {
        requestBodyHash: request.requestBodyHash, requestEnvelopeHash: request.requestEnvelopeHash,
        connectionProfileHash: request.requestEnvelope.connectionProfileHash,
      }) : null;
      const child = spawn(process.execPath, [...launch.flags, launch.entry], {
        cwd: '/', env: launch.environment, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      const output: Buffer[] = [];
      let stdoutBytes = 0; let stderrBytes = 0; let failure: string | null = null; let finished = false;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const detach = (): void => {
        clearTimeout(timer); if (cleanupTimer) clearTimeout(cleanupTimer);
        process.removeListener('exit', parentExit); signal.removeEventListener('abort', abort);
      };
      const stop = (code: string): void => {
        failure ??= code; child.kill('SIGKILL');
        if (!cleanupTimer) cleanupTimer = setTimeout(() => {
          if (finished) return;
          finished = true; detach();
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
          if (child.connected) child.disconnect();
          child.unref();
          reject(new HarnessError('READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE'));
        }, 5_000);
      };
      const abort = (): void => stop('READONLY_MODEL_PREFLIGHT_CANCELLED');
      const parentExit = (): void => { child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('READONLY_MODEL_PREFLIGHT_TIMEOUT'), this.timeoutMs);
      process.once('exit', parentExit); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 128 * 1024) stop('READONLY_MODEL_PREFLIGHT_OUTPUT_LIMIT');
        else if (!failure) output.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 16 * 1024) stop('READONLY_MODEL_PREFLIGHT_OUTPUT_LIMIT');
      });
      child.stdin!.on('error', () => undefined);
      child.on('error', () => { stop('READONLY_MODEL_PREFLIGHT_PROCESS_FAILED'); });
      child.once('close', (code) => {
        if (finished) return;
        finished = true; detach();
        try { lifecycle?.closed(child.pid ?? null); }
        catch { failure = 'READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE'; }
        if (failure || code !== 0) { reject(new HarnessError(failure ?? 'READONLY_MODEL_PREFLIGHT_PROCESS_FAILED')); return; }
        try {
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output));
          const result = parseReadonlyTransportJson(raw, 128 * 1024) as DecodedResponse;
          if (!result || Object.keys(result).sort().join(',') !== 'responseHash,text' || typeof result.text !== 'string'
            || Buffer.byteLength(result.text) > 16 * 1024 || typeof result.responseHash !== 'string'
            || !/^[a-f0-9]{64}$/u.test(result.responseHash)) throw new Error();
          resolve(result);
        } catch { reject(new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_RESPONSE')); }
      });
      try {
        if (child.pid) lifecycle?.spawned(child.pid);
        else stop('READONLY_MODEL_PREFLIGHT_PROCESS_FAILED');
        if (!failure) child.stdin!.end(wire);
      } catch { stop('READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE'); }
    });
  }
}
