import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { companyInvestigationSummary, parseCompanyInvestigationSummary, parseCompanyInvestigationWorkerOptions } from '../src/cli/company-investigation-protocol.js';
import { superviseCompanyInvestigationWorker } from '../src/cli/company-investigation-supervisor.js';
import type { CompanyV3SupervisorClock } from '../src/cli/company-readonly-v3-supervisor.js';

const id = '11111111-1111-4111-8111-111111111111';
const completed = () => ({ ...companyInvestigationSummary('run', id), status: 'REPORTED', planHash: 'a'.repeat(64),
  expiresAt: '2026-01-01T01:00:00.000Z', auditExpiresAt: '2026-01-02T00:00:00.000Z', approval: 'used', attempts: 1, mockCalls: 1, reportAvailable: true });
test('company investigation protocol accepts a complete mock result and rejects inconsistent success claims and leaked fields', () => {
  assert.deepEqual(parseCompanyInvestigationSummary(JSON.stringify(completed()), 'run', id), completed());
  for (const changed of [{ approval: 'none' }, { attempts: 0 }, { mockCalls: 0 }, { reportAvailable: false }, { mode: 'live' },
    { transmissionAllowed: true }, { realModel: 'passed' }, { prunedPayloads: 1 }, { excerpt: 'untrusted body' }, { taskId: null }, { planHash: 'bad' }]) {
    assert.throws(() => parseCompanyInvestigationSummary(JSON.stringify({ ...completed(), ...changed }), 'run', id));
  }
  const raw = JSON.stringify(completed());
  assert.throws(() => parseCompanyInvestigationSummary(raw.replace('{', '{"mode":"mock",'), 'run', id));
  assert.throws(() => parseCompanyInvestigationSummary(raw, 'inspect', id));
});
test('company investigation protocol rejects extra worker options and mixed command inputs', () => {
  const options = { version: 'company-investigation-worker-v1', command: 'run', sourceDirectory: '/private/harness', runtimeDirectory: '/private/run',
    preparationDirectory: '/private/prepared', preparationId: null, taskId: id, planHash: 'a'.repeat(64), expiresInMinutes: null };
  assert.deepEqual(parseCompanyInvestigationWorkerOptions(JSON.stringify(options)), options);
  for (const changed of [{ mode: 'live' }, { command: 'approve', expiresInMinutes: 61 }, { preparationDirectory: null },
    { command: 'inspect' }, { taskId: null }, { preparationId: id }, { sourceDirectory: '/private/../target' }]) {
    assert.throws(() => parseCompanyInvestigationWorkerOptions(JSON.stringify({ ...options, ...changed })));
  }
});

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
      const due = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
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
test('company investigation supervisor requires close and exact successful summary before reporting completion', async () => {
  const worker = new Worker(), time = new Clock(); let settled = false;
  const result = superviseCompanyInvestigationWorker(worker.child(), 'run', id, 0, time).then(value => { settled = true; return value; });
  worker.stdout.write(JSON.stringify(completed())); worker.emit('exit', 0, null); await Promise.resolve(); assert.equal(settled, false);
  worker.emit('close', 0, null);
  assert.deepEqual(await result, { summary: completed(), reason: 'completed', exitConfirmed: true }); assert.equal(time.timers.size, 0);
});
test('company investigation supervisor uses the remaining fixed 125s run budget and 250ms termination grace', async () => {
  const worker = new Worker(), time = new Clock(); time.value = 1000;
  const result = superviseCompanyInvestigationWorker(worker.child(), 'run', id, 0, time);
  time.advance(123999); assert.deepEqual(worker.signals, []);
  time.advance(1); assert.deepEqual(worker.signals, ['SIGTERM']);
  time.advance(250); assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']);
  worker.emit('close', null, 'SIGKILL');
  assert.deepEqual(await result, { summary: null, reason: 'deadline', exitConfirmed: true });
});
test('company investigation supervisor discards oversized output and never forwards stderr bodies', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const worker = new Worker(), time = new Clock(), result = superviseCompanyInvestigationWorker(worker.child(), 'run', id, 0, time);
    worker[stream].write(Buffer.alloc(stream === 'stdout' ? 65537 : 16385, 120));
    assert.deepEqual(worker.signals, ['SIGTERM']); worker.emit('close', null, 'SIGTERM');
    assert.deepEqual(await result, { summary: null, reason: 'output_limit', exitConfirmed: true });
  }
});
