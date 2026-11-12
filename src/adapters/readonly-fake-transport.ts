import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyTransportPort } from '../ports/readonly-transport.js';
import { readonlyTransportWorkerLaunch } from './readonly-transport-worker-contract.js';
import { createReadonlyTransportLifecycle, type ReadonlyTransportLocation } from './readonly-transport-lifecycle.js';

/** 실제 모델/인증/네트워크 없이 최종 요청 바이트만 고정 응답 worker에 전달한다. */
export class RestrictedReadonlyFakeTransport implements ReadonlyTransportPort {
  readonly mode = 'offline' as const;
  readonly transport = 'fake' as const;

  constructor(private readonly timeoutMs = 60_000, private readonly location?: ReadonlyTransportLocation) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new HarnessError('READONLY_TRANSPORT_INVALID_LIMIT');
    }
  }

  transmit(requestBody: string, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) return Promise.reject(new HarnessError('READONLY_TRANSPORT_CANCELLED'));
    if (typeof requestBody !== 'string' || Buffer.byteLength(requestBody) > 256 * 1024) {
      return Promise.reject(new HarnessError('READONLY_TRANSPORT_REQUEST_LIMIT'));
    }
    return new Promise((resolve, reject) => {
      const launch = readonlyTransportWorkerLaunch();
      const lifecycle = this.location ? createReadonlyTransportLifecycle(this.location,
        createHash('sha256').update(requestBody).digest('hex')) : null;
      const child = spawn(process.execPath, [...launch.flags, launch.entry], {
        cwd: '/', env: launch.environment, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      const output: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: string | null = null;
      const stop = (code: string): void => { failure ??= code; child.kill('SIGKILL'); };
      const abort = (): void => stop('READONLY_TRANSPORT_CANCELLED');
      const parentExit = (): void => { child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('READONLY_TRANSPORT_TIMEOUT'), this.timeoutMs);
      process.once('exit', parentExit);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 256 * 1024) stop('READONLY_TRANSPORT_RESPONSE_LIMIT');
        else if (!failure) output.push(chunk);
      });
      // 원시 stderr는 저장·출력하지 않으며 별도로 한도를 적용한다.
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 16 * 1024) stop('READONLY_TRANSPORT_OUTPUT_LIMIT');
      });
      child.stdin!.on('error', () => undefined);
      child.on('error', () => { failure ??= 'READONLY_TRANSPORT_PROCESS_FAILED'; });
      child.once('close', (code) => {
        clearTimeout(timer);
        process.removeListener('exit', parentExit);
        signal.removeEventListener('abort', abort);
        try { lifecycle?.closed(child.pid ?? null); }
        catch { failure ??= 'READONLY_TRANSPORT_LIFECYCLE_UNSAFE'; }
        if (failure || code !== 0) reject(new HarnessError(failure ?? 'READONLY_TRANSPORT_PROCESS_FAILED'));
        else resolve(Buffer.concat(output));
      });
      try {
        if (child.pid) lifecycle?.spawned(child.pid);
        else stop('READONLY_TRANSPORT_PROCESS_FAILED');
        if (!failure) child.stdin!.end(requestBody);
      } catch { stop('READONLY_TRANSPORT_LIFECYCLE_UNSAFE'); }
    });
  }
}
