import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createCompanyRelayIpcDirectory } from '../src/cli/company-relay-ipc.js';
import { companyRelaySummary, parseCompanyRelayWorkerOptions } from '../src/cli/company-relay-protocol.js';
import { superviseCompanyRelayWorker } from '../src/cli/company-relay-supervisor.js';
import type { CompanyV3SupervisorClock } from '../src/cli/company-readonly-v3-supervisor.js';

const id = '11111111-1111-4111-8111-111111111111';
const completed = () => ({ ...companyRelaySummary('run', id), status: 'REPORTED', planHash: 'a'.repeat(64),
  expiresAt: '2026-01-01T01:00:00.000Z', auditExpiresAt: '2026-01-02T00:00:00.000Z', approval: 'used', attempts: 1,
  dispatchReservations: 1, reportAvailable: true, verification: 'fake' });
type Timer = ReturnType<typeof setTimeout>;
class Clock implements CompanyV3SupervisorClock {
  value = 0;
  timers = new Map<Timer, { at: number; callback: () => void }>();
  now(): number { return this.value; }
  schedule(callback: () => void, milliseconds: number): Timer {
    const timer = Object.freeze({}) as Timer; this.timers.set(timer, { at: this.value + milliseconds, callback }); return timer;
  }
  cancel(timer: Timer): void { this.timers.delete(timer); }
  advance(milliseconds: number): void {
    const target = this.value + milliseconds;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.value = due[1].at; this.timers.delete(due[0]); due[1].callback();
    }
    this.value = target;
  }
}
class Worker extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); signals: string[] = [];
  kill(signal: string): boolean { this.signals.push(signal); return true; }
  child(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

test('company relay supervisor requires exact summary and closed pipes, not just process exit', async () => {
  const worker = new Worker(), time = new Clock(); let settled = false;
  const pending = superviseCompanyRelayWorker(worker.child(), 'run', id, 0, time).then(value => { settled = true; return value; });
  worker.stdout.write(JSON.stringify(completed())); worker.emit('exit', 0, null); await Promise.resolve();
  assert.equal(settled, false); worker.emit('close', 0, null);
  assert.deepEqual(await pending, { summary: completed(), reason: 'completed', exitConfirmed: true }); assert.equal(time.timers.size, 0);
});

for (const preflightMilliseconds of [0, 1000, 30_000, 119_999]) {
  test(`company relay reserves 5s cleanup within the global125s after ${preflightMilliseconds}ms preflight`, async () => {
    const worker = new Worker(), time = new Clock(); time.value = preflightMilliseconds;
    const pending = superviseCompanyRelayWorker(worker.child(), 'run', id, 0, time);
    time.advance(120_000 - preflightMilliseconds - 1); assert.deepEqual(worker.signals, []);
    time.advance(1); assert.deepEqual(worker.signals, ['SIGTERM']);
    time.advance(4999); assert.deepEqual(worker.signals, ['SIGTERM']);
    time.advance(1); assert.equal(time.now(), 125_000); assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']);
    worker.emit('close', null, 'SIGKILL');
    assert.deepEqual(await pending, { summary: null, reason: 'deadline', exitConfirmed: true }); assert.equal(time.timers.size, 0);
  });
}

test('late worker start cannot receive another full work or cleanup budget', async () => {
  for (const elapsed of [123_000, 125_000, 130_000]) {
    const worker = new Worker(), time = new Clock(); time.value = elapsed;
    const pending = superviseCompanyRelayWorker(worker.child(), 'run', id, 0, time);
    time.advance(0); assert.equal(worker.signals[0], 'SIGTERM');
    if (elapsed < 125_000) {
      assert.deepEqual(worker.signals, ['SIGTERM']); time.advance(125_000 - elapsed - 1); assert.deepEqual(worker.signals, ['SIGTERM']); time.advance(1);
    }
    assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']); worker.emit('close', null, 'SIGKILL');
    assert.deepEqual(await pending, { summary: null, reason: 'deadline', exitConfirmed: true });
  }
});

for (const stream of ['stdout', 'stderr'] as const) {
  test(`early ${stream} overflow gets only the shared 5s cleanup and discards every output byte`, async () => {
    const worker = new Worker(), time = new Clock(); time.value = 2000;
    const pending = superviseCompanyRelayWorker(worker.child(), 'run', id, 0, time);
    worker[stream].write(Buffer.alloc(stream === 'stdout' ? 65_537 : 16_385, 120));
    worker.stdout.write(JSON.stringify(completed())); assert.deepEqual(worker.signals, ['SIGTERM']);
    time.advance(4999); assert.deepEqual(worker.signals, ['SIGTERM']); time.advance(1);
    assert.equal(time.now(), 7000); assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']); worker.emit('close', null, 'SIGKILL');
    assert.deepEqual(await pending, { summary: null, reason: 'output_limit', exitConfirmed: true }); assert.equal(time.timers.size, 0);
  });
}

test('output overflow close to the total deadline does not extend cleanup beyond125s', async () => {
  const worker = new Worker(), time = new Clock(); time.value = 124_000;
  const pending = superviseCompanyRelayWorker(worker.child(), 'run', id, 0, time);
  worker.stdout.write(Buffer.alloc(65_537)); assert.deepEqual(worker.signals, ['SIGTERM']);
  time.advance(999); assert.deepEqual(worker.signals, ['SIGTERM']); time.advance(1);
  assert.equal(time.now(), 125_000); assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']); worker.emit('close', null, 'SIGKILL');
  assert.deepEqual(await pending, { summary: null, reason: 'output_limit', exitConfirmed: true });
});

test('a response after termination or total expiry cannot become successful', async () => {
  for (const expiredTimer of [true, false]) {
    const worker = new Worker(), time = new Clock();
    const pending = superviseCompanyRelayWorker(worker.child(), 'run', id, 0, time);
    if (expiredTimer) time.advance(120_000); else time.value = 125_000;
    worker.stdout.write(JSON.stringify(completed())); worker.emit('close', 0, null);
    assert.deepEqual(await pending, { summary: null, reason: 'deadline', exitConfirmed: true });
  }
});

test('worker failure and malformed or leaking summaries are fixed public outcomes', async () => {
  for (const output of ['{', `${JSON.stringify(completed())}\n${JSON.stringify(completed())}`, JSON.stringify({ ...completed(), sourceBody: 'PRIVATE_SYNTHETIC_BODY' }),
    JSON.stringify({ ...completed(), dispatchReservations: 0 }), Buffer.from([0xff])]) {
    const worker = new Worker(), time = new Clock();
    const pending = superviseCompanyRelayWorker(worker.child(), 'run', id, 0, time);
    worker.stdout.write(output); worker.emit('close', 0, null);
    assert.deepEqual(await pending, { summary: null, reason: 'invalid_output', exitConfirmed: true });
  }
  const worker = new Worker(), time = new Clock();
  const pending = superviseCompanyRelayWorker(worker.child(), 'run', id, 0, time);
  worker.emit('error', new Error('PRIVATE_SYNTHETIC_ERROR')); assert.deepEqual(worker.signals, ['SIGTERM']); worker.emit('close', 1, null);
  assert.deepEqual(await pending, { summary: null, reason: 'worker_failed', exitConfirmed: true });
});

test('non-run company command keeps its30s deadline and250ms termination grace', async () => {
  const worker = new Worker(), time = new Clock(); time.value = 2000;
  const pending = superviseCompanyRelayWorker(worker.child(), 'inspect', id, 0, time);
  time.advance(27_999); assert.deepEqual(worker.signals, []); time.advance(1); assert.deepEqual(worker.signals, ['SIGTERM']);
  time.advance(249); assert.deepEqual(worker.signals, ['SIGTERM']); time.advance(1); assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']);
  worker.emit('close', null, 'SIGKILL'); assert.deepEqual(await pending, { summary: null, reason: 'deadline', exitConfirmed: true });
});

test('worker protocol admits exactly one short IPC directory only for explicit run', () => {
  const options = { version: 'company-relay-worker-v1', command: 'run', sourceDirectory: '/private/harness', runtimeDirectory: '/private/run',
    preparationDirectory: '/private/prepared', authorizationFile: '/private/policy/company-relay-authorization.json', ipcDirectory: '/private/tmp/hcri-aB123x',
    preparationId: null, taskId: id, planHash: 'a'.repeat(64), expiresInMinutes: null };
  assert.deepEqual(parseCompanyRelayWorkerOptions(JSON.stringify(options)), options);
  for (const changed of [{ ipcDirectory: null }, { ipcDirectory: '/private/tmp' }, { ipcDirectory: '/private/tmp/hcri-abcdef/child' },
    { ipcDirectory: '/private/tmp/hcri-abcdef/../hcri-ghijkl' }, { ipcDirectory: '/tmp/hcri-abcdef' }, { command: 'approve', expiresInMinutes: 10 },
    { extraNetworkPermission: true }]) {
    assert.throws(() => parseCompanyRelayWorkerOptions(JSON.stringify({ ...options, ...changed })));
  }
});

test('parent creates an empty owned0700 IPC directory and removes only that same empty directory', async context => {
  const ipc = await createCompanyRelayIpcDirectory(); context.after(() => rm(ipc.path, { recursive: true, force: true }));
  assert.match(ipc.path, /^\/private\/tmp\/hcri-[A-Za-z0-9]{6}$/u);
  const metadata = await lstat(ipc.path); assert.equal(metadata.uid, process.getuid?.()); assert.equal(metadata.mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(ipc.path), []); assert.equal(await ipc.cleanup(), true);
  await assert.rejects(lstat(ipc.path), { code: 'ENOENT' });
});

test('IPC cleanup never recursively deletes a remaining file or socket entry', async context => {
  const ipc = await createCompanyRelayIpcDirectory(); context.after(() => rm(ipc.path, { recursive: true, force: true }));
  const file = join(ipc.path, 'pending.sock'); await writeFile(file, 'SYNTHETIC_PENDING_ENDPOINT', { mode: 0o600 });
  assert.equal(await ipc.cleanup(), false); assert.equal(await readFile(file, 'utf8'), 'SYNTHETIC_PENDING_ENDPOINT');
  await rm(file); assert.equal(await ipc.cleanup(), true);
});

test('IPC cleanup refuses a replaced directory and preserves both original and replacement', async context => {
  const ipc = await createCompanyRelayIpcDirectory(), original = `${ipc.path}-original`;
  context.after(async () => { await rm(ipc.path, { recursive: true, force: true }); await rm(original, { recursive: true, force: true }); });
  const identity = await lstat(ipc.path); await rename(ipc.path, original); await mkdir(ipc.path, { mode: 0o700 });
  assert.equal(await ipc.cleanup(), false);
  assert.equal((await lstat(original)).ino, identity.ino); assert.notEqual((await lstat(ipc.path)).ino, identity.ino);
});

test('IPC cleanup never follows a replacement symbolic link', async context => {
  const ipc = await createCompanyRelayIpcDirectory(), original = `${ipc.path}-original`;
  context.after(async () => { await rm(ipc.path, { force: true }); await rm(original, { recursive: true, force: true }); });
  await rename(ipc.path, original); await symlink(original, ipc.path);
  assert.equal(await ipc.cleanup(), false); assert.equal((await lstat(ipc.path)).isSymbolicLink(), true);
  assert.equal((await lstat(original)).isDirectory(), true);
});
