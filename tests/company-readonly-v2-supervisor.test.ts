import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { superviseCompanyV2Worker, type CompanyV2SupervisorClock } from '../src/cli/company-readonly-v2-supervisor.js';
import { companyV2Disabled, parseCompanyV2Summary, parseCompanyV2WorkerOptions,
  type CompanyV2Command, type CompanyV2Summary } from '../src/cli/company-readonly-v2-protocol.js';
import { getCompanyGitRangeProfile, getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';

const limits = getCompanyGitRangeProfile().limits;
const taskId = '11111111-1111-4111-8111-111111111111';
type Timer = ReturnType<typeof setTimeout>;
class ManualClock implements CompanyV2SupervisorClock {
  #now = 0;
  readonly #timers = new Map<Timer, { at: number; callback: () => void }>();
  now(): number { return this.#now; }
  schedule(callback: () => void, milliseconds: number): Timer {
    const timer = Object.freeze({}) as Timer;
    this.#timers.set(timer, { at: this.#now + milliseconds, callback }); return timer;
  }
  cancel(timer: Timer): void { this.#timers.delete(timer); }
  pending(): number { return this.#timers.size; }
  jumpTo(now: number): void { this.#now = now; }
  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      const due = [...this.#timers].filter(([, entry]) => entry.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.#now = due[1].at; this.#timers.delete(due[0]); due[1].callback();
    }
    this.#now = target;
  }
}
class Worker extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: (NodeJS.Signals | number)[] = [];
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean { this.signals.push(signal); return true; }
  child(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}
const summary = (command: CompanyV2Command = 'plan'): CompanyV2Summary => ({ version: 'company-readonly-v2-result-v1', command,
  taskId: command === 'prune' ? null : taskId, status: command === 'prune' ? 'PRUNED' : command === 'cancel' ? 'CANCELLED' : 'AWAITING_APPROVAL',
  planHash: command === 'prune' ? null : 'a'.repeat(64), createdAt: command === 'prune' ? null : '2026-01-01T00:00:00.000Z',
  expiresAt: command === 'prune' ? null : '2026-01-01T01:00:00.000Z', auditExpiresAt: command === 'prune' ? null : '2026-01-02T00:00:00.000Z',
  reviewAvailable: command === 'plan' || command === 'inspect', prunedPayloads: 0, prunedRecords: 0,
  gitProfileHash: getCompanyGitRangeProfileHash(), peakRssBytes: 64 * 1024 * 1024, oldSpaceMiB: 128, ...companyV2Disabled });
const write = (worker: Worker, value: unknown): void => { worker.stdout.write(`${JSON.stringify(value)}\n`); };

test('a valid reply needs process close confirmation and a zero exit before the supervisor reports completion', async () => {
  const worker = new Worker(), time = new ManualClock(); let settled = false;
  const result = superviseCompanyV2Worker(worker.child(), 'plan', taskId, 0, time).then(value => { settled = true; return value; });
  write(worker, summary()); await Promise.resolve(); assert.equal(settled, false);
  worker.emit('exit', 0, null); await Promise.resolve(); assert.equal(settled, false);
  worker.emit('close', 0, null);
  assert.deepEqual(await result, { summary: summary(), reason: 'completed', exitConfirmed: true });
  assert.deepEqual(worker.signals, []); assert.equal(time.pending(), 0);
});

test('the original 30-second deadline sends SIGTERM then SIGKILL after 250ms and still waits for close', async () => {
  const worker = new Worker(), time = new ManualClock(); time.jumpTo(1000); let settled = false;
  const result = superviseCompanyV2Worker(worker.child(), 'plan', taskId, 0, time).then(value => { settled = true; return value; });
  write(worker, summary()); time.advance(limits.wallClockMs - 1001); assert.deepEqual(worker.signals, []);
  time.advance(1); assert.deepEqual(worker.signals, ['SIGTERM']); await Promise.resolve(); assert.equal(settled, false);
  time.advance(limits.terminationGraceMs - 1); assert.deepEqual(worker.signals, ['SIGTERM']);
  time.advance(1); assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']);
  worker.emit('exit', null, 'SIGKILL'); await Promise.resolve(); assert.equal(settled, false);
  worker.emit('close', null, 'SIGKILL');
  assert.deepEqual(await result, { summary: null, reason: 'deadline', exitConfirmed: true });
  assert.equal(time.pending(), 0);
});

test('a valid reply cannot override nonzero exit, signal exit or a deadline missed during event-loop delay', async () => {
  for (const mode of ['code', 'signal', 'late'] as const) {
    const worker = new Worker(), time = new ManualClock(), result = superviseCompanyV2Worker(worker.child(), 'plan', taskId, 0, time);
    write(worker, summary());
    if (mode === 'late') time.jumpTo(limits.wallClockMs);
    worker.emit('close', mode === 'code' ? 1 : 0, mode === 'signal' ? 'SIGTERM' : null);
    assert.deepEqual(await result, { summary: null, reason: mode === 'late' ? 'deadline' : 'worker_failed', exitConfirmed: true });
    assert.equal(time.pending(), 0);
  }
});

test('stdout and stderr caps terminate without retaining an oversized reply and require close confirmation', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const worker = new Worker(), time = new ManualClock(); let settled = false;
    const result = superviseCompanyV2Worker(worker.child(), 'plan', taskId, 0, time).then(value => { settled = true; return value; });
    if (stream === 'stderr') write(worker, summary());
    worker[stream].write(Buffer.alloc(65_536)); assert.deepEqual(worker.signals, []);
    worker[stream].write(Buffer.from('x')); assert.deepEqual(worker.signals, ['SIGTERM']);
    await Promise.resolve(); assert.equal(settled, false);
    worker.emit('close', 0, null);
    assert.deepEqual(await result, { summary: null, reason: 'output_limit', exitConfirmed: true });
    time.advance(limits.terminationGraceMs); assert.deepEqual(worker.signals, ['SIGTERM']);
    assert.equal(time.pending(), 0);
  }
});

test('malformed JSON, invalid UTF-8, wrong IDs and extra body fields never become a successful result', async () => {
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ ...summary(), taskId: '22222222-2222-4222-8222-222222222222' })),
    Buffer.from(JSON.stringify({ ...summary(), reviewInput: 'UNEXPECTED_PRIVATE_BODY' })),
    Buffer.from(`${JSON.stringify(summary())}\n${JSON.stringify(summary())}`)]) {
    const worker = new Worker(), time = new ManualClock(), result = superviseCompanyV2Worker(worker.child(), 'plan', taskId, 0, time);
    worker.stdout.write(bytes); worker.emit('close', 0, null);
    assert.deepEqual(await result, { summary: null, reason: 'invalid_output', exitConfirmed: true });
  }
});

test('child and stream errors remain fixed failure reasons even after a valid reply', async () => {
  for (const emitter of ['child', 'stdout', 'stderr'] as const) {
    const worker = new Worker(), time = new ManualClock(), result = superviseCompanyV2Worker(worker.child(), 'plan', taskId, 0, time);
    write(worker, summary());
    if (emitter === 'child') worker.emit('error', new Error('PRIVATE_NATIVE_ERROR'));
    else worker[emitter].emit('error', new Error('PRIVATE_NATIVE_ERROR'));
    assert.deepEqual(worker.signals, ['SIGTERM']); worker.emit('close', 0, null);
    assert.deepEqual(await result, { summary: null, reason: 'worker_failed', exitConfirmed: true });
  }
});

test('protocol fixes profile, old-space and disabled capabilities and checks lifecycle summary shapes', () => {
  for (const command of ['plan', 'inspect', 'cancel', 'prune'] as const) {
    const value = summary(command); assert.deepEqual(parseCompanyV2Summary(JSON.stringify(value), command, value.taskId), value);
  }
  for (const patch of [{ oldSpaceMiB: 256 }, { gitProfileHash: '0'.repeat(64) }, { approvalCreated: true },
    { transmissionAllowed: true }, { executionAllowed: true }, { companyPolicyVerified: true }, { nativeExecution: 'passed' },
    { realModel: 'passed' }, { peakRssBytes: 0 }, { prunedPayloads: 1 }, { reviewAvailable: false },
    { expiresAt: '2025-12-31T23:00:00.000Z' }, { status: 'NOT_FOUND', planHash: null }]) {
    assert.throws(() => parseCompanyV2Summary(JSON.stringify({ ...summary(), ...patch }), 'plan', taskId),
      { code: 'COMPANY_READONLY_V2_INVALID_WORKER_OUTPUT' });
  }
  const absent = { ...summary('inspect'), status: 'NOT_FOUND', planHash: null, createdAt: null, expiresAt: null, auditExpiresAt: null, reviewAvailable: false };
  assert.deepEqual(parseCompanyV2Summary(JSON.stringify(absent), 'inspect', taskId), absent);
  assert.throws(() => parseCompanyV2Summary(JSON.stringify(summary('plan')), 'cancel', taskId),
    { code: 'COMPANY_READONLY_V2_INVALID_WORKER_OUTPUT' });
});

test('worker options reject new capabilities, missing command fields and malformed fixed identity data', () => {
  const value = { command: 'plan', sourceDirectory: '/synthetic/harness', runtimeDirectory: '/synthetic/private-runtime', taskId,
    startedAt: '2026-01-01T00:00:00.000Z', policyFile: '/synthetic/policy.json', registrationFile: '/synthetic/registration.json',
    policyHash: 'a'.repeat(64), registrationHash: 'b'.repeat(64) };
  assert.deepEqual(parseCompanyV2WorkerOptions(JSON.stringify(value)), value);
  for (const changed of [{ ...value, model: 'unexpected' }, { ...value, oldSpaceMiB: 256 }, { ...value, command: 'run' },
    { ...value, taskId: 'wrong' }, { ...value, startedAt: 'not-a-date' }, { ...value, policyHash: 'bad' },
    { ...value, registrationFile: undefined }, { ...value, sourceDirectory: 17 }]) {
    assert.throws(() => parseCompanyV2WorkerOptions(JSON.stringify(changed)), { code: 'COMPANY_READONLY_V2_INVALID_WORKER_INPUT' });
  }
});
