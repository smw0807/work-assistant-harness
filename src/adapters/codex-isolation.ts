import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import type { CodexConfig } from '../domain/codex-config.js';
import { HarnessError } from '../domain/errors.js';

/** macOS SBPL은 쓰기·실행을 기본 거부하고 전용 broker TCP 포트만 연다. */
export const codexSandboxProfile = (executable: string, workspace: string, port: number, managedPreferences = false): string => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HarnessError('INVALID_CODEX_BROKER');
  if (typeof managedPreferences !== 'boolean') throw new HarnessError('INVALID_CODEX_PREFERENCES');
  const uid = managedPreferences ? process.getuid?.() : undefined;
  if (managedPreferences && (!Number.isSafeInteger(uid) || uid! < 0)) throw new HarnessError('INVALID_CODEX_PREFERENCES');
  const quote = (value: string): string => JSON.stringify(value);
  return [
    '(version 1)', '(deny default)', '(import "dyld-support.sb")',
    `(allow process-exec (literal ${quote(executable)}))`,
    '(allow sysctl-read)', '(allow mach-bootstrap)', '(allow syscall*)', '(allow file-read-metadata)',
    `(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib") (literal ${quote(executable)}))`,
    `(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (literal "/dev/null") (literal "/dev/urandom") (literal ${quote(executable)}) (subpath ${quote(workspace)}))`,
    `(allow file-write* (subpath ${quote(workspace)}) (literal "/dev/null"))`,
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    '(allow system-socket (require-all (socket-domain AF_INET) (socket-type SOCK_STREAM)))',
    ...(managedPreferences ? [
      '(allow user-preference-read (preference-domain "com.openai.codex"))',
      '(allow mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (local-name "com.apple.cfprefsd.agent"))',
      // CFPreferences uses read-only generation counters; other users and shared-memory writes remain denied.
      `(allow ipc-posix-shm-read* (ipc-posix-name "apple.cfprefs.${uid}v1") (ipc-posix-name "apple.cfprefs.daemonv1"))`,
    ] : []),
  ].join('\n');
};

export const verifyCodexBinary = async (config: CodexConfig): Promise<void> => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new HarnessError('CODEX_HOST_UNSUPPORTED');
  const metadata = await lstat(config.codexPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0
    || metadata.size > 512 * 1024 * 1024 || await realpath(config.codexPath) !== config.codexPath) {
    throw new HarnessError('UNSAFE_CODEX_BINARY');
  }
  const handle = await open(config.codexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== metadata.ino || opened.dev !== metadata.dev) throw new HarnessError('UNSAFE_CODEX_BINARY');
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || hash.digest('hex') !== config.codexSha256) {
      throw new HarnessError('CODEX_BINARY_CHANGED');
    }
  } finally { await handle.close(); }
};

export const runSandboxedCodex = (
  executable: string, arguments_: string[], workspace: string, port: number,
  environment: NodeJS.ProcessEnv, input: string, signal: AbortSignal, maxBytes: number, managedPreferences = false,
): Promise<string> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new HarnessError('CODEX_CALL_ABORTED')); return; }
  const profile = codexSandboxProfile(executable, workspace, port, managedPreferences);
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'codex-process.js')], {
    cwd: workspace, env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const output: Buffer[] = []; let size = 0; let failure: string | null = null;
  const kill = (): void => { if (child.connected) child.send({ cancel: true }, () => undefined); };
  const abort = (): void => { failure = 'CODEX_CALL_ABORTED'; kill(); };
  signal.addEventListener('abort', abort, { once: true });
  const consume = (bytes: Buffer, stdout: boolean): void => {
    size += bytes.length;
    if (size > maxBytes) { failure = 'CODEX_OUTPUT_LIMIT'; kill(); }
    else if (stdout) output.push(bytes);
  };
  child.stdout!.on('data', (bytes: Buffer) => consume(bytes, true));
  // 원시 stderr는 크기만 계산하고 보존·출력하지 않는다.
  child.stderr!.on('data', (bytes: Buffer) => consume(bytes, false));
  child.on('error', () => { failure = 'CODEX_PROCESS_FAILED'; });
  child.on('close', (code) => {
    signal.removeEventListener('abort', abort);
    if (failure || code !== 0) reject(new HarnessError(failure ?? 'CODEX_PROCESS_FAILED'));
    else resolve(Buffer.concat(output).toString('utf8'));
  });
  child.send({ executable, arguments: arguments_, profile, workspace,
    environment, input, maxBytes }, () => undefined);
});

/** The company parent owns one short directory and retains its identity through probe cleanup. */
export const inspectCompanyCodexIpcDirectory = async (path: string,
  expected?: { device: number; inode: number }): Promise<{ device: number; inode: number }> => {
  if (typeof path !== 'string' || !/^\/private\/tmp\/hcri-[A-Za-z0-9]{6}$/u.test(path)) throw new HarnessError('READONLY_RELAY_LIFECYCLE_UNSAFE');
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o7777) !== 0o700 || await realpath(path) !== path || (await readdir(path)).length !== 0
    || expected && (metadata.dev !== expected.device || metadata.ino !== expected.inode)) {
    throw new HarnessError('READONLY_RELAY_LIFECYCLE_UNSAFE');
  }
  return { device: metadata.dev, inode: metadata.ino };
};

/** 실제 모델 호출 전에 동일한 SBPL 생성기로 파일/쓰기/exec/network/Unix socket 경계를 시험한다. */
export const probeCodexIsolation = async (root: string, workspace: string, brokerPort: number, signal: AbortSignal,
  companyIpcDirectory?: string, managedPreferences = false): Promise<void> => {
  const companyIdentity = companyIpcDirectory === undefined ? null : await inspectCompanyCodexIpcDirectory(companyIpcDirectory);
  const canary = join(root, 'host-canary.txt');
  await writeFile(canary, 'synthetic isolation canary', { flag: 'wx', mode: 0o600 });
  // macOS sockaddr_un 경로 제한 때문에 긴 data directory 밖에 소유한 짧은 진단 경로를 만든다.
  const socketDirectory = companyIpcDirectory ?? await mkdtemp('/private/tmp/harness-codex-ipc-');
  const socketPath = join(socketDirectory, 'probe.sock');
  const server = createServer((socket) => socket.end());
  const deniedServer = createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await new Promise<void>((resolve, reject) => { deniedServer.once('error', reject); deniedServer.listen(0, '127.0.0.1', resolve); });
    const address = deniedServer.address();
    if (!address || typeof address === 'string') throw new HarnessError('CODEX_ISOLATION_FAILED');
    const script = [
      "const fs = require('node:fs'); const net = require('node:net'); const cp = require('node:child_process');",
      'const denied = (operation) => { try { operation(); throw Error("allowed"); } catch (e) { if (!["EPERM", "EACCES"].includes(e.code)) throw e; } };',
      `denied(() => fs.readFileSync(${JSON.stringify(canary)}));`,
      `denied(() => fs.writeFileSync(${JSON.stringify(join(root, 'escape.txt'))}, 'unexpected'));`,
      "const child = cp.spawnSync('/usr/bin/true'); if (!child.error || !['EPERM','EACCES'].includes(child.error.code)) throw Error('exec allowed');",
      'const connection = (options, allowed) => new Promise((resolve, reject) => { const socket = net.connect(options); socket.setTimeout(1000); socket.on("connect", () => { socket.destroy(); allowed ? resolve() : reject(Error("network allowed")); }); socket.on("error", (e) => { !allowed && ["EPERM","EACCES"].includes(e.code) ? resolve() : reject(e); }); socket.on("timeout", () => { socket.destroy(); reject(Error("timeout")); }); });',
      `(async () => { await connection({host:'127.0.0.1',port:${brokerPort}},true); await connection({host:'127.0.0.1',port:${address.port}},false); await connection({path:${JSON.stringify(socketPath)}},false); console.log('ISOLATION_PASSED'); })().catch(() => process.exit(1));`,
    ].join('\n');
    const nodePath = await realpath(process.execPath);
    const output = await runSandboxedCodex(nodePath, ['--no-addons', '-e', script], workspace, brokerPort,
      { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: workspace }, '', signal, 4096, managedPreferences);
    if (output.trim() !== 'ISOLATION_PASSED') throw new HarnessError('CODEX_ISOLATION_FAILED');
  } finally {
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => deniedServer.close(() => resolve()))]);
    if (companyIdentity) await inspectCompanyCodexIpcDirectory(socketDirectory, companyIdentity);
    else await rmdir(socketDirectory);
  }
};
