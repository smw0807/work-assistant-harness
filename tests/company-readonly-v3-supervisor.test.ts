import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { CompanyGitRangeUnitFailure } from '../src/domain/company-git-range-unit.js';
import { COMPANY_V3_DIAGNOSTIC_VERSION, formatCompanyV3Diagnostic } from '../src/cli/company-readonly-v3-diagnostic-protocol.js';
import { superviseCompanyV3Worker, type CompanyV3SupervisorClock } from '../src/cli/company-readonly-v3-supervisor.js';
import { formatCompanyV3WorkerFailure } from '../src/cli/company-readonly-v3-worker-failure.js';
import { companyV3Disabled, parseCompanyV3Summary, parseCompanyV3WorkerOptions,
  type CompanyV3Command, type CompanyV3Summary } from '../src/cli/company-readonly-v3-protocol.js';
import { CompanyGitRangeUnitBudget, extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitProfile,
  getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { parseCompanyV2Summary, parseCompanyV2WorkerOptions } from '../src/cli/company-readonly-v2-protocol.js';

const limits = getCompanyGitRangeUnitProfile().limits;
const taskId = '11111111-1111-4111-8111-111111111111';
type Timer = ReturnType<typeof setTimeout>;
class ManualClock implements CompanyV3SupervisorClock {
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
const summary = (command: CompanyV3Command = 'plan'): CompanyV3Summary => ({ version: 'company-readonly-v3-result-v1', command,
  taskId: command === 'prune' ? null : taskId, status: command === 'prune' ? 'PRUNED' : command === 'cancel' ? 'CANCELLED' : 'AWAITING_APPROVAL',
  planHash: command === 'prune' ? null : 'a'.repeat(64), createdAt: command === 'prune' ? null : '2026-01-01T00:00:00.000Z',
  expiresAt: command === 'prune' ? null : '2026-01-01T01:00:00.000Z', auditExpiresAt: command === 'prune' ? null : '2026-01-02T00:00:00.000Z',
  reviewAvailable: command === 'plan' || command === 'inspect', prunedPayloads: 0, prunedRecords: 0,
  gitProfileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), peakRssBytes: 64 * 1024 * 1024, oldSpaceMiB: 128, ...companyV3Disabled });
const write = (worker: Worker, value: unknown): void => { worker.stdout.write(`${JSON.stringify(value)}\n`); };
const diagnosticFailure = (): CompanyGitRangeUnitFailure => {
  const budget = new CompanyGitRangeUnitBudget(0);
  budget.beginPass('inspect', 0);
  budget.setStage('pack_index');
  try { budget.failLimit('indexObjects', limits.indexObjects, 1, limits.indexObjects); }
  catch (error) {
    const failure = extractCompanyGitRangeUnitFailure(error);
    assert.ok(failure);
    return failure;
  }
  return assert.fail('expected the synthetic budget limit to fail');
};

test('a valid reply needs process close confirmation and a zero exit before the supervisor reports completion', async () => {
  const worker = new Worker(), time = new ManualClock(); let settled = false;
  const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time).then(value => { settled = true; return value; });
  write(worker, summary()); await Promise.resolve(); assert.equal(settled, false);
  worker.emit('exit', 0, null); await Promise.resolve(); assert.equal(settled, false);
  worker.emit('close', 0, null);
  assert.deepEqual(await result, { summary: summary(), reason: 'completed', exitConfirmed: true });
  assert.deepEqual(worker.signals, []); assert.equal(time.pending(), 0);
});

test('the original 30-second deadline sends SIGTERM then SIGKILL after 250ms and still waits for close', async () => {
  const worker = new Worker(), time = new ManualClock(); time.jumpTo(1000); let settled = false;
  const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time).then(value => { settled = true; return value; });
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
    const worker = new Worker(), time = new ManualClock(), result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time);
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
    const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time).then(value => { settled = true; return value; });
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
    const worker = new Worker(), time = new ManualClock(), result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time);
    worker.stdout.write(bytes); worker.emit('close', 0, null);
    assert.deepEqual(await result, { summary: null, reason: 'invalid_output', exitConfirmed: true });
  }
});

test('child and stream errors remain fixed failure reasons even after a valid reply', async () => {
  for (const emitter of ['child', 'stdout', 'stderr'] as const) {
    const worker = new Worker(), time = new ManualClock(), result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time);
    write(worker, summary());
    if (emitter === 'child') worker.emit('error', new Error('PRIVATE_NATIVE_ERROR'));
    else worker[emitter].emit('error', new Error('PRIVATE_NATIVE_ERROR'));
    assert.deepEqual(worker.signals, ['SIGTERM']); worker.emit('close', 0, null);
    assert.deepEqual(await result, { summary: null, reason: 'worker_failed', exitConfirmed: true });
  }
});

test('protocol fixes profile, old-space and disabled capabilities and checks lifecycle summary shapes', () => {
  for (const command of ['plan', 'inspect', 'cancel', 'prune'] as const) {
    const value = summary(command); assert.deepEqual(parseCompanyV3Summary(JSON.stringify(value), command, value.taskId), value);
  }
  for (const patch of [{ oldSpaceMiB: 256 }, { gitProfileHash: '0'.repeat(64) }, { guardPolicyHash: '0'.repeat(64) },
    { guardPolicyHash: undefined }, { gitProfileHash: getCompanyGitRangeProfileHash() }, { version: 'company-readonly-v2-result-v1' }, { approvalCreated: true },
    { transmissionAllowed: true }, { executionAllowed: true }, { companyPolicyVerified: true }, { nativeExecution: 'passed' },
    { realModel: 'passed' }, { peakRssBytes: 0 }, { prunedPayloads: 1 }, { reviewAvailable: false },
    { expiresAt: '2025-12-31T23:00:00.000Z' }, { status: 'NOT_FOUND', planHash: null }]) {
    assert.throws(() => parseCompanyV3Summary(JSON.stringify({ ...summary(), ...patch }), 'plan', taskId),
      { code: 'COMPANY_READONLY_V3_INVALID_WORKER_OUTPUT' });
  }
  const absent = { ...summary('inspect'), status: 'NOT_FOUND', planHash: null, createdAt: null, expiresAt: null, auditExpiresAt: null, reviewAvailable: false };
  assert.deepEqual(parseCompanyV3Summary(JSON.stringify(absent), 'inspect', taskId), absent);
  assert.throws(() => parseCompanyV3Summary(JSON.stringify(summary('plan')), 'cancel', taskId),
    { code: 'COMPANY_READONLY_V3_INVALID_WORKER_OUTPUT' });
});

test('worker options reject new capabilities, missing command fields and malformed fixed identity data', () => {
  const value = { version: 'company-readonly-v3-worker-input-v1', gitProfileHash: getCompanyGitRangeUnitProfileHash(),
    guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), command: 'plan', sourceDirectory: '/synthetic/harness', runtimeDirectory: '/synthetic/private-runtime', taskId,
    startedAt: '2026-01-01T00:00:00.000Z', policyFile: '/synthetic/policy.json', registrationFile: '/synthetic/registration.json',
    policyHash: 'a'.repeat(64), registrationHash: 'b'.repeat(64) };
  assert.deepEqual(parseCompanyV3WorkerOptions(JSON.stringify(value)), value);
  for (const changed of [{ ...value, model: 'unexpected' }, { ...value, oldSpaceMiB: 256 }, { ...value, command: 'run' },
    { ...value, taskId: 'wrong' }, { ...value, startedAt: 'not-a-date' }, { ...value, policyHash: 'bad' },
    { ...value, registrationFile: undefined }, { ...value, sourceDirectory: 17 }]) {
    assert.throws(() => parseCompanyV3WorkerOptions(JSON.stringify(changed)), { code: 'COMPANY_READONLY_V3_INVALID_WORKER_INPUT' });
  }
});

test('v3 worker input identity rejects missing or mixed versions and profiles for every command', () => {
  for (const command of ['plan', 'inspect', 'cancel', 'prune'] as const) {
    const input = { version: 'company-readonly-v3-worker-input-v1', command, sourceDirectory: '/synthetic/harness',
      runtimeDirectory: '/synthetic/runtime', gitProfileHash: getCompanyGitRangeUnitProfileHash(),
      guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), ...(command === 'prune' ? {} : { taskId }),
      ...(command === 'plan' ? { startedAt: '2026-01-01T00:00:00.000Z', policyFile: '/synthetic/policy.json',
        registrationFile: '/synthetic/registration-v3.json', policyHash: 'a'.repeat(64), registrationHash: 'b'.repeat(64) } : {}) };
    assert.deepEqual(parseCompanyV3WorkerOptions(JSON.stringify(input)), input);
    for (const patch of [{ version: undefined }, { version: 'company-readonly-v2-worker-input-v1' },
      { gitProfileHash: undefined }, { gitProfileHash: getCompanyGitRangeProfileHash() },
      { guardPolicyHash: undefined }, { guardPolicyHash: '0'.repeat(64) }]) {
      assert.throws(() => parseCompanyV3WorkerOptions(JSON.stringify({ ...input, ...patch })),
        { code: 'COMPANY_READONLY_V3_INVALID_WORKER_INPUT' });
    }
    assert.throws(() => parseCompanyV2WorkerOptions(JSON.stringify(input)), { code: 'COMPANY_READONLY_V2_INVALID_WORKER_INPUT' });
    assert.throws(() => parseCompanyV2Summary(JSON.stringify(summary(command)), command, command === 'prune' ? null : taskId),
      { code: 'COMPANY_READONLY_V2_INVALID_WORKER_OUTPUT' });
  }
});

test('opt-in supervision carries a fragmented bounded failure frame only after confirmed worker close', async () => {
  const worker = new Worker(), time = new ManualClock(), failure = diagnosticFailure();
  let settled = false;
  const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true).then(value => { settled = true; return value; });
  const frame = formatCompanyV3Diagnostic(taskId, failure);
  worker.stderr.write(frame.slice(0, 17)); worker.stderr.write(frame.slice(17));
  worker.stderr.write('COMPANY_GIT_RANGE_LIMIT\n');
  await Promise.resolve(); assert.equal(settled, false);
  worker.emit('exit', 1, null); await Promise.resolve(); assert.equal(settled, false);
  worker.emit('close', 1, null);
  assert.deepEqual(await result, { summary: null, reason: 'worker_failed', exitConfirmed: true, failureDiagnostic: failure });
  assert.equal(time.pending(), 0);
  assert.deepEqual(worker.signals, []);
});

test('default supervision ignores diagnostic frames and preserves both existing outcome shapes exactly', async () => {
  for (const code of [0, 1]) {
    const worker = new Worker(), time = new ManualClock();
    const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time);
    worker.stderr.write(formatCompanyV3Diagnostic(taskId, diagnosticFailure()));
    write(worker, summary()); worker.emit('close', code, null);
    assert.deepEqual(await result, code === 0 ? { summary: summary(), reason: 'completed', exitConfirmed: true }
      : { summary: null, reason: 'worker_failed', exitConfirmed: true });
  }
});

test('opt-in success keeps the original worker summary unchanged and has no failure diagnostic', async () => {
  const worker = new Worker(), time = new ManualClock();
  const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true);
  write(worker, summary()); worker.emit('close', 0, null);
  assert.deepEqual(await result, { summary: summary(), reason: 'completed', exitConfirmed: true, failureDiagnostic: null });
});

test('an opt-in failure frame conflicts with a successful summary and cannot report success', async () => {
  const worker = new Worker(), time = new ManualClock(), failure = diagnosticFailure();
  const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true);
  worker.stderr.write(formatCompanyV3Diagnostic(taskId, failure));
  write(worker, summary()); worker.emit('close', 0, null);
  assert.deepEqual(await result, { summary: null, reason: 'invalid_output', exitConfirmed: true, failureDiagnostic: failure });
});

test('duplicate, wrong-task, incomplete and oversized frames become null without retaining their contents', async () => {
  const frame = formatCompanyV3Diagnostic(taskId, diagnosticFailure());
  const cases = [frame + frame, frame.replace(taskId, '22222222-2222-4222-8222-222222222222'), frame.trimEnd(),
    frame.replace('\n', `${' '.repeat(8193)}\n`), `${frame}${Buffer.alloc(65_536, 'x').toString()}`];
  for (const text of cases) {
    const worker = new Worker(), time = new ManualClock();
    const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true);
    worker.stderr.write(text); worker.emit('close', 1, null);
    const oversized = Buffer.byteLength(text) > 65_536;
    assert.deepEqual(await result, { summary: null, reason: oversized ? 'output_limit' : 'worker_failed', exitConfirmed: true, failureDiagnostic: null });
    assert.deepEqual(worker.signals, oversized ? ['SIGTERM'] : []);
    assert.equal(time.pending(), 0);
  }
});

test('deadline termination remains authoritative while retaining a valid failure frame received before close', async () => {
  const worker = new Worker(), time = new ManualClock(), failure = diagnosticFailure();
  let settled = false;
  const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true).then(value => { settled = true; return value; });
  time.advance(limits.wallClockMs);
  assert.deepEqual(worker.signals, ['SIGTERM']);
  worker.stderr.write(formatCompanyV3Diagnostic(taskId, failure));
  time.advance(limits.terminationGraceMs);
  assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']);
  await Promise.resolve(); assert.equal(settled, false);
  worker.emit('close', null, 'SIGKILL');
  assert.deepEqual(await result, { summary: null, reason: 'deadline', exitConfirmed: true, failureDiagnostic: failure });
  assert.equal(time.pending(), 0);
});

test('non-plan supervision never treats an opt-in failure frame as a plan diagnostic', async () => {
  for (const command of ['inspect', 'cancel', 'prune'] as const) {
    const worker = new Worker(), time = new ManualClock();
    const result = superviseCompanyV3Worker(worker.child(), command, command === 'prune' ? null : taskId, 0, time, true);
    worker.stderr.write(formatCompanyV3Diagnostic(taskId, diagnosticFailure()));
    write(worker, summary(command)); worker.emit('close', 0, null);
    assert.deepEqual(await result, { summary: summary(command), reason: 'completed', exitConfirmed: true, failureDiagnostic: null });
  }
});

test('worker diagnostics option is exact, optional and allowed only on plan without any directory or extra capability', () => {
  const value = { version: 'company-readonly-v3-worker-input-v1', gitProfileHash: getCompanyGitRangeUnitProfileHash(),
    guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), command: 'plan', sourceDirectory: '/synthetic/harness', runtimeDirectory: '/synthetic/private-runtime', taskId,
    startedAt: '2026-01-01T00:00:00.000Z', policyFile: '/synthetic/policy.json', registrationFile: '/synthetic/registration.json',
    policyHash: 'a'.repeat(64), registrationHash: 'b'.repeat(64) };
  assert.deepEqual(parseCompanyV3WorkerOptions(JSON.stringify(value)), value);
  const diagnostic = { ...value, diagnosticsVersion: COMPANY_V3_DIAGNOSTIC_VERSION };
  assert.deepEqual(parseCompanyV3WorkerOptions(JSON.stringify(diagnostic)), diagnostic);
  for (const diagnosticsVersion of ['company-git-range-failure-v1', 'company-git-range-failure-v3', '', true, null, {}, 1]) {
    assert.throws(() => parseCompanyV3WorkerOptions(JSON.stringify({ ...value, diagnosticsVersion })),
      { code: 'COMPANY_READONLY_V3_INVALID_WORKER_INPUT' });
  }
  for (const field of ['diagnosticsDirectory', 'diagnosticFile', 'transmissionAllowed', 'model']) {
    assert.throws(() => parseCompanyV3WorkerOptions(JSON.stringify({ ...diagnostic, [field]: '/synthetic/extra' })),
      { code: 'COMPANY_READONLY_V3_INVALID_WORKER_INPUT' });
  }
  for (const command of ['inspect', 'cancel', 'prune'] as const) {
    const other = { version: 'company-readonly-v3-worker-input-v1', gitProfileHash: value.gitProfileHash,
      guardPolicyHash: value.guardPolicyHash, command, sourceDirectory: value.sourceDirectory, runtimeDirectory: value.runtimeDirectory,
      ...(command === 'prune' ? {} : { taskId }) };
    assert.deepEqual(parseCompanyV3WorkerOptions(JSON.stringify(other)), other);
    assert.throws(() => parseCompanyV3WorkerOptions(JSON.stringify({ ...other, diagnosticsVersion: COMPANY_V3_DIAGNOSTIC_VERSION })),
      { code: 'COMPANY_READONLY_V3_INVALID_WORKER_INPUT' });
  }
});

test('a task-bound worker failure code is exposed only after a clean failure close', async () => {
  const worker = new Worker(), time = new ManualClock(); let settled = false;
  const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true).then(value => { settled = true; return value; });
  const frame = formatCompanyV3WorkerFailure(taskId, 'COMPANY_GIT_RANGE_SOURCE_CHANGED');
  worker.stderr.write(frame.slice(0, 19)); worker.stderr.write(frame.slice(19));
  worker.stderr.write('COMPANY_GIT_RANGE_SOURCE_CHANGED\n');
  worker.emit('exit', 1, null); await Promise.resolve(); assert.equal(settled, false);
  worker.emit('close', 1, null);
  assert.deepEqual(await result, { summary: null, reason: 'worker_failed', exitConfirmed: true,
    failureDiagnostic: null, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' });
  assert.equal(time.pending(), 0); assert.deepEqual(worker.signals, []);
});

test('a matching worker code coexists with the original budget diagnostic but a conflicting code is omitted', async () => {
  for (const matches of [true, false]) {
    const worker = new Worker(), time = new ManualClock(), failure = diagnosticFailure();
    const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true);
    worker.stderr.write(formatCompanyV3Diagnostic(taskId, failure));
    worker.stderr.write(formatCompanyV3WorkerFailure(taskId, matches ? 'COMPANY_GIT_RANGE_LIMIT' : 'COMPANY_GIT_RANGE_SOURCE_CHANGED'));
    worker.emit('close', 1, null);
    assert.deepEqual(await result, { summary: null, reason: 'worker_failed', exitConfirmed: true,
      failureDiagnostic: failure, ...(matches ? { workerFailureCode: 'COMPANY_GIT_RANGE_LIMIT' } : {}) });
  }
});

test('a worker failure code cannot turn a successful summary into completion', async () => {
  const worker = new Worker(), time = new ManualClock();
  const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true);
  worker.stderr.write(formatCompanyV3WorkerFailure(taskId, 'COMPANY_READONLY_V3_PREPARATION_FAILED'));
  write(worker, summary()); worker.emit('close', 0, null);
  assert.deepEqual(await result, { summary: null, reason: 'invalid_output', exitConfirmed: true, failureDiagnostic: null });
});

test('termination, stream errors and other exit codes never retain a worker failure code', async () => {
  for (const mode of ['deadline', 'late', 'stdout-limit', 'stderr-limit', 'signal', 'other-code', 'child-error', 'stdout-error', 'stderr-error'] as const) {
    const worker = new Worker(), time = new ManualClock();
    const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true);
    worker.stderr.write(formatCompanyV3WorkerFailure(taskId, 'COMPANY_GIT_RANGE_SOURCE_CHANGED'));
    if (mode === 'deadline') time.advance(limits.wallClockMs);
    if (mode === 'late') time.jumpTo(limits.wallClockMs);
    if (mode === 'stdout-limit') worker.stdout.write(Buffer.alloc(65_537));
    if (mode === 'stderr-limit') worker.stderr.write(Buffer.alloc(65_537));
    if (mode === 'child-error') worker.emit('error', new Error('SYNTHETIC_PRIVATE_ERROR'));
    if (mode === 'stdout-error') worker.stdout.emit('error', new Error('SYNTHETIC_PRIVATE_ERROR'));
    if (mode === 'stderr-error') worker.stderr.emit('error', new Error('SYNTHETIC_PRIVATE_ERROR'));
    worker.emit('close', mode === 'other-code' ? 2 : mode === 'signal' ? null : 1, mode === 'signal' ? 'SIGTERM' : null);
    const value = await result;
    assert.deepEqual(value, { summary: null, reason: mode === 'deadline' || mode === 'late' ? 'deadline'
      : mode === 'stdout-limit' || mode === 'stderr-limit' ? 'output_limit' : 'worker_failed', exitConfirmed: true, failureDiagnostic: null });
    assert.equal(JSON.stringify(value).includes('SYNTHETIC_PRIVATE_ERROR'), false);
    assert.equal(time.pending(), 0);
  }
});

test('unbound, duplicate, malformed and raw worker errors never become a persisted code', async () => {
  const frame = formatCompanyV3WorkerFailure(taskId, 'COMPANY_GIT_RANGE_SOURCE_CHANGED');
  for (const text of [frame + frame, frame.trimEnd(), frame.replace(taskId, '22222222-2222-4222-8222-222222222222'),
    frame.replace('COMPANY_GIT_RANGE_SOURCE_CHANGED', 'COMPANY_GIT_RANGE_PRIVATE_BODY'), 'COMPANY_GIT_RANGE_SOURCE_CHANGED\n']) {
    const worker = new Worker(), time = new ManualClock();
    const result = superviseCompanyV3Worker(worker.child(), 'plan', taskId, 0, time, true);
    worker.stderr.write(text); worker.emit('close', 1, null);
    assert.deepEqual(await result, { summary: null, reason: 'worker_failed', exitConfirmed: true, failureDiagnostic: null });
  }
});

test('worker failure frames leave default and non-plan supervisor contracts unchanged', async () => {
  for (const command of ['plan', 'inspect', 'cancel', 'prune'] as const) {
    for (const code of [0, 1]) {
      const worker = new Worker(), time = new ManualClock(), diagnostics = command !== 'plan';
      const result = superviseCompanyV3Worker(worker.child(), command, command === 'prune' ? null : taskId, 0, time, diagnostics);
      worker.stderr.write(formatCompanyV3WorkerFailure(taskId, 'COMPANY_GIT_RANGE_SOURCE_CHANGED'));
      write(worker, summary(command)); worker.emit('close', code, null);
      assert.deepEqual(await result, { summary: code === 0 ? summary(command) : null,
        reason: code === 0 ? 'completed' : 'worker_failed', exitConfirmed: true, ...(diagnostics ? { failureDiagnostic: null } : {}) });
    }
  }
});
