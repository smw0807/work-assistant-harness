import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runSandboxedCodex } from '../src/adapters/codex-isolation.js';

const nativeProbe = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1';
const skip = nativeProbe ? false : 'macOS와 HARNESS_NATIVE_CODEX_PROBE=1이 필요한 실제 sandbox-exec 검사';

interface ReadySignal { childPid: number; guardianPid: number; mode: 'silent' | 'stdout' }

const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};
const killIfPresent = (pid: number): void => {
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
};
const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
  const timer = setTimeout(() => reject(new Error('controller did not exit')), 3000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
});

const prepare = async (t: TestContext): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-process-')));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

// 외부 연결·로그인 없이 실제 production guardian을 호출하는 신뢰하는 부모 프로세스다.
const controllerScript = String.raw`
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
const [workspace, mode, isolationUrl, nativeNode] = process.argv.slice(1);
const { runSandboxedCodex } = await import(isolationUrl);
const readyPath = join(workspace, 'ready.json');
const payload = [
  "const fs = require('node:fs');",
  "const mode = " + JSON.stringify(mode) + ";",
  "const announce = () => {",
  "fs.writeFileSync(" + JSON.stringify(readyPath + '.tmp') + ", JSON.stringify({ childPid: process.pid, guardianPid: process.ppid, mode }), { flag: 'wx', mode: 0o600 });",
  "fs.renameSync(" + JSON.stringify(readyPath + '.tmp') + ", " + JSON.stringify(readyPath) + ");",
  "}; let writes = 0; if (mode === 'silent') announce();",
  "setInterval(() => { if (mode === 'stdout') { process.stdout.write('SYNTHETIC_OUTPUT\\n'.repeat(32)); writes += 1; if (writes === 32) announce(); } }, 1);",
].join('\n');
let completed = false;
const execution = runSandboxedCodex(nativeNode, ['--no-addons', '-e', payload], workspace, 12345,
  { HOME: workspace, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, '', new AbortController().signal, 64 * 1024 * 1024)
  .then(() => { completed = true; }, () => { completed = true; });
let ready = null;
for (let attempt = 0; attempt < 500; attempt += 1) {
  if (completed) throw Error('sandbox child exited before READY');
  try { ready = JSON.parse(await readFile(readyPath, 'utf8')); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await delay(10);
}
if (!ready) throw Error('sandbox READY timeout');
process.stdout.write(JSON.stringify(ready) + '\n');
await execution;
process.exitCode = 2;
`;

const readReady = (controller: ChildProcess): Promise<ReadySignal> => new Promise((resolve, reject) => {
  let stdout = ''; let stderr = '';
  const timer = setTimeout(() => reject(new Error(`sandbox READY timeout: ${stderr}`)), 7000);
  controller.stderr!.on('data', (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(0, 4096); });
  controller.stdout!.on('data', (bytes: Buffer) => {
    stdout += bytes.toString();
    if (!stdout.includes('\n')) return;
    clearTimeout(timer);
    try {
      const ready = JSON.parse(stdout.split('\n')[0]!) as ReadySignal;
      assert.ok(Number.isSafeInteger(ready.childPid) && ready.childPid > 1);
      assert.ok(Number.isSafeInteger(ready.guardianPid) && ready.guardianPid > 1);
      assert.notEqual(ready.childPid, ready.guardianPid);
      resolve(ready);
    } catch (error) { reject(error); }
  });
  controller.once('exit', (code, signal) => {
    clearTimeout(timer); reject(new Error(`controller exited before READY (${code}/${signal}): ${stderr}`));
  });
  controller.once('error', (error) => { clearTimeout(timer); reject(error); });
});

for (const mode of ['silent', 'stdout'] as const) {
  test(`Codex guardian은 ${mode} 자식의 부모 SIGKILL 뒤 실제 격리 프로세스 그룹을 정리한다`, { skip, timeout: 15_000 }, async (t) => {
    const workspace = await prepare(t);
    const controller = spawn(process.execPath, ['--input-type=module', '-e', controllerScript, workspace, mode,
      new URL('../src/adapters/codex-isolation.js', import.meta.url).href, await realpath(process.execPath)], {
      env: { HOME: workspace, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready: ReadySignal | null = null;
    t.after(async () => {
      if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL');
      await waitForExit(controller);
      if (ready) { killIfPresent(-ready.childPid); killIfPresent(ready.guardianPid); }
    });
    ready = await readReady(controller);
    assert.equal(ready.mode, mode);
    assert.notEqual(ready.guardianPid, controller.pid);
    assert.ok(processExists(ready.childPid)); assert.ok(processExists(ready.guardianPid));
    assert.ok(processExists(-ready.childPid), 'sandbox child must own its detached process group');
    const exited = waitForExit(controller);
    assert.equal(controller.kill('SIGKILL'), true);
    await exited;
    assert.equal(controller.signalCode, 'SIGKILL');
    const deadline = Date.now() + 3000;
    while ((processExists(ready.childPid) || processExists(ready.guardianPid)) && Date.now() < deadline) await delay(25);
    // 이 확인 전에는 테스트가 guardian이나 자식을 직접 종료하지 않는다.
    assert.equal(processExists(ready.childPid), false, 'sandbox child survived controller SIGKILL');
    assert.equal(processExists(ready.guardianPid), false, 'guardian survived controller SIGKILL');
    assert.equal(processExists(-ready.childPid), false, 'detached child process group survived');
  });
}

test('실제 Codex sandbox는 허용된 native Node 자신의 추가 실행도 거부한다', { skip, timeout: 15_000 }, async (t) => {
  const workspace = await prepare(t);
  const nativeNode = await realpath(process.execPath);
  const script = [
    "const { spawnSync } = require('node:child_process');",
    "const child = spawnSync(process.execPath, ['--version']);",
    "if (!child.error || !['EPERM', 'EACCES'].includes(child.error.code)) throw Error('SELF_EXEC_ALLOWED');",
    "process.stdout.write('SELF_EXEC_DENIED\\n');",
  ].join('\n');
  const output = await runSandboxedCodex(nativeNode, ['--no-addons', '-e', script], workspace, 12345,
    { HOME: workspace, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, '', AbortSignal.timeout(7000), 4096);
  assert.equal(output, 'SELF_EXEC_DENIED\n');
});
