import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { codexSandboxProfile } from './codex-isolation.js';
import type { ReadonlyRelayLocation } from './readonly-relay-lifecycle.js';

export const runReadonlyRelayProcess = (
  executable: string, arguments_: string[], workspace: string, port: number, environment: NodeJS.ProcessEnv,
  input: string, signal: AbortSignal, location: ReadonlyRelayLocation,
): Promise<string> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new HarnessError('READONLY_RELAY_CANCELLED')); return; }
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'readonly-relay-process.js')], {
    cwd: workspace, env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let failure: string | null = null;
  let size = 0;
  let stderrBytes = 0;
  const chunks: Buffer[] = [];
  const cancel = (): void => { if (child.connected) child.send({ cancel: true }, () => undefined); };
  const abort = (): void => { failure = 'READONLY_RELAY_CANCELLED'; cancel(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const consume = (bytes: Buffer, stdout: boolean): void => {
    size += bytes.length;
    if (!stdout) stderrBytes += bytes.length;
    if (size > 128 * 1024 || stderrBytes > 16 * 1024) { failure = 'READONLY_RELAY_OUTPUT_LIMIT'; cancel(); }
    else if (stdout) chunks.push(bytes);
  };
  child.stdout!.on('data', (bytes: Buffer) => consume(bytes, true));
  child.stderr!.on('data', (bytes: Buffer) => consume(bytes, false));
  child.on('error', () => { failure = 'READONLY_RELAY_PROCESS_FAILED'; });
  child.on('close', (code) => {
    signal.removeEventListener('abort', abort);
    if (failure || code !== 0) reject(new HarnessError(failure ?? 'READONLY_RELAY_PROCESS_FAILED'));
    else {
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new HarnessError('READONLY_RELAY_INVALID_RESPONSE')); }
    }
  });
  child.send({ executable, arguments: arguments_, profile: codexSandboxProfile(executable, workspace, port),
    workspace, environment, input, maxBytes: 128 * 1024, location }, () => undefined);
});
