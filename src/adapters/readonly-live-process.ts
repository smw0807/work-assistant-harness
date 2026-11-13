import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readonlyLiveScratchIdentity, removeReadonlyLiveScratch, updateReadonlyLiveChild, type ReadonlyLiveLocation, type ReadonlyLiveScratchIdentity } from './readonly-live-lifecycle.js';

interface ProcessRequest {
  executable: string; arguments: string[]; profile: string; workspace: string;
  environment: NodeJS.ProcessEnv; input: string; maxBytes: number; location: ReadonlyLiveLocation;
}
let child: ChildProcessWithoutNullStreams | null = null;
let request: ProcessRequest | null = null;
let failed = false;
let size = 0;
let stderrBytes = 0;
const stop = (): void => {
  failed = true;
  try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already closed. */ }
  if (!child) process.exit(1);
};
const timer = setTimeout(stop, 55_000);
process.stdout.on('error', stop);
process.on('exit', () => { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already closed. */ } });
process.on('disconnect', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('message', (message: ProcessRequest | { cancel: true }) => {
  if ('cancel' in message || request) { stop(); return; }
  request = message;
  let scratch: ReadonlyLiveScratchIdentity;
  try {
    scratch = readonlyLiveScratchIdentity(message.location);
    updateReadonlyLiveChild(message.location, 'intent', process.pid, null);
  } catch { stop(); return; }
  child = spawn('/usr/bin/sandbox-exec', ['-p', message.profile, message.executable, ...message.arguments], {
    cwd: message.workspace, env: message.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try { if (child.pid) updateReadonlyLiveChild(message.location, 'spawned', process.pid, child.pid); } catch { stop(); }
  const consume = (bytes: Buffer, stdout: boolean): void => {
    size += bytes.length;
    if (!stdout) stderrBytes += bytes.length;
    if (size > message.maxBytes || stderrBytes > 16 * 1024) { stop(); return; }
    if (stdout && !failed && !process.stdout.write(bytes)) {
      child?.stdout.pause(); process.stdout.once('drain', () => child?.stdout.resume());
    }
  };
  child.stdout.on('data', (bytes: Buffer) => consume(bytes, true));
  child.stderr.on('data', (bytes: Buffer) => consume(bytes, false));
  child.stdin.on('error', () => undefined);
  child.on('error', () => { failed = true; });
  child.on('close', (code) => {
    clearTimeout(timer);
    try {
      removeReadonlyLiveScratch(message.location, scratch);
      updateReadonlyLiveChild(message.location, 'closed', process.pid, child?.pid ?? null);
    }
    catch { failed = true; }
    process.stdout.end(() => process.exit(failed ? 1 : code === 0 ? 0 : 1));
  });
  child.stdin.end(message.input);
});
