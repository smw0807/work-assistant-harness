import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import { readonlyWorkerLaunch } from './readonly-worker-contract.js';
import { createReadonlyModelLifecycle, type ReadonlyModelLocation } from './readonly-model-lifecycle.js';

/** 승인된 직렬화 입력만 stdin으로 전달하는 네트워크 없는 고정 응답 모델. */
export class RestrictedReadonlyModel {
  readonly mode = 'mock' as const;

  constructor(private readonly timeoutMs = 60_000, private readonly location?: ReadonlyModelLocation) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new HarnessError('READONLY_INVALID_MODEL_LIMIT');
    }
  }

  investigate(inputText: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(new HarnessError('READONLY_MODEL_CANCELLED'));
    if (typeof inputText !== 'string' || Buffer.byteLength(inputText) > 128 * 1024) {
      return Promise.reject(new HarnessError('READONLY_MODEL_INPUT_LIMIT'));
    }
    return new Promise((resolve, reject) => {
      const launch = readonlyWorkerLaunch();
      const lifecycle = this.location ? createReadonlyModelLifecycle(this.location, createHash('sha256').update(inputText).digest('hex')) : null;
      const child = spawn(process.execPath, [...launch.flags, launch.entry], {
        cwd: '/', env: launch.environment, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      const output: Buffer[] = [];
      let bytes = 0;
      let failure: string | null = null;
      const stop = (code: string): void => {
        failure ??= code;
        child.kill('SIGKILL');
      };
      const abort = (): void => stop('READONLY_MODEL_CANCELLED');
      const parentExit = (): void => { child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('READONLY_MODEL_TIMEOUT'), this.timeoutMs);
      process.once('exit', parentExit);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const consume = (chunk: Buffer, stdout: boolean): void => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) stop('READONLY_MODEL_OUTPUT_LIMIT');
        else if (stdout) output.push(chunk);
      };
      child.stdout!.on('data', (chunk: Buffer) => consume(chunk, true));
      // 원시 stderr는 크기만 계산하고 상위 로그·보고서로 보내지 않는다.
      child.stderr!.on('data', (chunk: Buffer) => consume(chunk, false));
      child.stdin!.on('error', () => undefined);
      child.on('error', () => { failure ??= 'READONLY_MODEL_PROCESS_FAILED'; });
      child.once('close', (code) => {
        clearTimeout(timer);
        process.removeListener('exit', parentExit);
        signal.removeEventListener('abort', abort);
        try { lifecycle?.closed(child.pid ?? null); }
        catch { failure ??= 'READONLY_MODEL_LIFECYCLE_UNSAFE'; }
        if (failure || code !== 0) reject(new HarnessError(failure ?? 'READONLY_MODEL_PROCESS_FAILED'));
        else resolve(Buffer.concat(output).toString('utf8'));
      });
      try {
        if (child.pid) lifecycle?.spawned(child.pid);
        else stop('READONLY_MODEL_PROCESS_FAILED');
        if (!failure) child.stdin!.end(inputText);
      } catch { stop('READONLY_MODEL_LIFECYCLE_UNSAFE'); }
    });
  }
}
