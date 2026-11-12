import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// 신뢰하는 종료 감시자다. 인증 키 없이 sandbox-exec만 실행하고 부모 IPC 단절 때 자식 그룹을 종료한다.
interface ProcessRequest {
  executable: string; arguments: string[]; profile: string; workspace: string;
  environment: NodeJS.ProcessEnv; input: string; maxBytes: number;
}
let child: ChildProcessWithoutNullStreams | null = null;
let requested = false;
let failure = false;
let size = 0;
const stop = (): void => {
  failure = true;
  try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 종료됐다. */ }
  if (!child) process.exit(1);
};
const timeout = setTimeout(stop, 60_000);
process.stdout.on('error', stop);
process.on('exit', () => { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* 종료 확인 뒤에도 반복해도 안전하다. */ } });
process.on('disconnect', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('message', (message: ProcessRequest | { cancel: true }) => {
  if ('cancel' in message) { stop(); return; }
  if (requested) { stop(); return; }
  requested = true;
  child = spawn('/usr/bin/sandbox-exec', ['-p', message.profile, message.executable, ...message.arguments], {
    cwd: message.workspace, env: message.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const consume = (bytes: Buffer, stdout: boolean): void => {
    size += bytes.length;
    if (size > message.maxBytes) { stop(); return; }
    if (stdout && !failure && !process.stdout.write(bytes)) {
      child?.stdout.pause(); process.stdout.once('drain', () => child?.stdout.resume());
    }
  };
  child.stdout.on('data', (bytes: Buffer) => consume(bytes, true));
  child.stderr.on('data', (bytes: Buffer) => consume(bytes, false));
  child.stdin.on('error', () => undefined);
  child.on('error', () => { failure = true; });
  child.on('close', (code) => {
    clearTimeout(timeout);
    process.stdout.end(() => process.exit(failure ? 1 : code === 0 ? 0 : 1));
  });
  child.stdin.end(message.input);
});
