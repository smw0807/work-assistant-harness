import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { companyWriteIsolationLimits } from '../adapters/company-write-isolation.js';

interface Request { profile: string; repositoryRoot: string; input: string }
let child: ChildProcessWithoutNullStreams | null = null;
let requested = false, failure: string | null = null, bytes = 0;
let killTimer: NodeJS.Timeout | null = null;
const signalChild = (signal: NodeJS.Signals): void => {
  try { if (child?.pid) process.kill(-child.pid, signal); } catch { /* The recorded child group may have already exited. */ }
};
const stop = (code: string): void => {
  if (failure) return;
  failure = code;
  if (process.connected) process.send?.({ failure: code }, () => undefined);
  if (!child) process.exit(1);
  // A disconnected parent cannot drain stdout; resume the child pipe so close is still observed after kill.
  child.stdout.resume();
  signalChild('SIGTERM');
  killTimer = setTimeout(() => signalChild('SIGKILL'), companyWriteIsolationLimits.killGraceMs);
};
const timeout = setTimeout(() => stop('WORKER_TIMEOUT'), companyWriteIsolationLimits.timeoutMs);
process.stdout.on('error', () => stop('WORKER_FAILED'));
process.on('disconnect', () => stop('WORKER_ABORTED'));
process.on('SIGTERM', () => stop('WORKER_ABORTED'));
process.on('SIGINT', () => stop('WORKER_ABORTED'));
process.on('exit', () => signalChild('SIGKILL'));
process.on('message', (message: Request | { cancel: true }) => {
  if ('cancel' in message) { stop('WORKER_ABORTED'); return; }
  if (requested) { stop('WORKER_FAILED'); return; }
  requested = true;
  child = spawn('/usr/bin/sandbox-exec', ['-p', message.profile, realpathSync(process.execPath), '--no-addons',
    '--disable-proto=throw', '--max-old-space-size=128', join(dirname(fileURLToPath(import.meta.url)), 'company-write-worker.js')], {
    cwd: message.repositoryRoot, env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' },
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const consume = (chunk: Buffer, stdout: boolean): void => {
    bytes += chunk.length;
    if (bytes > companyWriteIsolationLimits.maxOutputBytes) { stop('WORKER_OUTPUT_LIMIT'); return; }
    if (stdout && !failure && !process.stdout.write(chunk)) {
      child?.stdout.pause(); process.stdout.once('drain', () => child?.stdout.resume());
    }
  };
  child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
  // Raw worker errors never cross the guardian boundary.
  child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
  child.stdin.on('error', () => stop('WORKER_FAILED'));
  child.on('error', () => stop('WORKER_FAILED'));
  child.on('close', code => {
    clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
    child = null;
    process.stdout.end(() => process.exit(failure || code !== 0 ? 1 : 0));
  });
  // EOF is a second parent-liveness signal inside the fixed worker; do not end this pipe after the request.
  child.stdin.write(message.input + '\n');
});
