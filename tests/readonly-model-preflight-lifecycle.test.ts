import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { chmodSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ReadonlyContext } from '../src/domain/readonly-investigation.js';
import { HarnessError } from '../src/domain/errors.js';
import type { ReadonlyModelPreflightPort, ReadonlyModelPreflightSnapshot } from '../src/ports/readonly-model-preflight.js';
import { SqliteReadonlyModelPreflightStore } from '../src/adapters/sqlite-readonly-model-preflight-store.js';
import { ReadonlyModelPreflightService } from '../src/application/investigate-model-preflight.js';
import { assertReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { defaultReadonlySelection } from '../src/policy/readonly-investigation-policy.js';

import { buildReadonlyModelPreflightFakeReport, hashReadonlyModelPreflightEnvelope } from '../src/policy/readonly-model-preflight-policy.js';
import type { ReadonlyModelPreflightDispatch, ReadonlyModelPreflightDecodedResponse } from '../src/domain/readonly-model-preflight.js';

const respond = (request: ReadonlyModelPreflightDispatch): ReadonlyModelPreflightDecodedResponse => {
  const text = buildReadonlyModelPreflightFakeReport(request.requestEnvelope.body);
  return { text, responseHash: createHash('sha256').update(text).digest('hex') };
};

const ownerId = `os-user:${process.getuid!()}`;
const context = (milliseconds = Date.now() + 10_000): ReadonlyContext => ({ ownerId, now: new Date(milliseconds) });
const code = (expected: string) => (error: unknown): boolean => error instanceof HarnessError && error.code === expected;
const removeFixture = async (directory: string): Promise<void> => {
  chmodSync(directory, 0o700);
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await removeFixture(join(directory, item.name));
  }
  await rm(directory, { recursive: true, force: true });
};
const setup = async (port?: ReadonlyModelPreflightPort) => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'readonly-model-preflight-lifecycle-')));
  chmodSync(directory, 0o700);
  const file = join(directory, 'readonly-model-preflights.sqlite');
  const store = new SqliteReadonlyModelPreflightStore(file);
  const received: ReadonlyModelPreflightDispatch[] = [];
  const model: ReadonlyModelPreflightPort = port ?? { mode: 'offline', transport: 'in-memory-fake', transmit: async (input) => { received.push(input); return respond(input); } };
  const service = new ReadonlyModelPreflightService(store, model, directory);
  const ctx = context();
  return { directory, file, store, service, received, ctx, close: async () => { store.close(); await removeFixture(directory); } };
};
const request = (snapshot: ReadonlyModelPreflightSnapshot) => ({ investigationId: snapshot.task.investigationId, planHash: snapshot.task.plan.planHash });
const approve = (h: Awaited<ReturnType<typeof setup>>, snapshot: ReadonlyModelPreflightSnapshot, expiresInMinutes = 60) => h.service.approve({ ...request(snapshot), expiresInMinutes }, h.ctx);

for (const requestId of ['flow-question', 'change-request'] as const) {
  test(`readonly model preflight lifecycle: ${requestId} reports approved bytes without execution`, async () => {
    const h = await setup();
    try {
      const planned = await h.service.plan('flow', defaultReadonlySelection(requestId), h.ctx, 'controller');
      assert.equal(h.received.length, 0);
      assert.equal(planned.payload!.context.evidence.length, 4);
      assert.equal(planned.task.plan.transferEvidenceIds.length, 1);
      await assert.rejects(h.service.run(request(planned), h.ctx), code('READONLY_MODEL_PREFLIGHT_APPROVAL_REQUIRED'));
      assert.equal(h.received.length, 0);
      approve(h, planned);
      const finished = await h.service.run(request(planned), h.ctx);
      assert.equal(finished.task.status, 'REPORTED');
      assert.equal(h.received.length, 1);
      assert.deepEqual(h.received[0]!.requestEnvelope, planned.payload!.requestEnvelope);
      assert.equal(createHash('sha256').update(h.received[0]!.requestEnvelope.body).digest('hex'), planned.task.plan.requestBodyHash);
      assert.equal(finished.report?.mode, 'offline');
      assert.equal(finished.report?.checks.realModel, 'not_run');
      assert.equal(finished.report?.checks.targetCodeExecution, 'not_run');
      assert.equal(finished.report?.semanticAccuracyVerified, false);
      assert.deepEqual(finished.task.plan.writeAllowedFiles, []);
      assert.deepEqual(finished.task.plan.testCommandIds, []);
      assert.equal(finished.task.plan.executionAllowed, false);
      assert.equal('consumeForExecution' in h.service, false);
      assert.ok(!JSON.stringify(h.received[0]!).includes(planned.payload!.repository.sourceRoot));
      await assertReadonlyRepository(planned.payload!.repository);
      await assert.rejects(h.service.run(request(planned), h.ctx));
      assert.equal(h.received.length, 1);
      assert.equal(statSync(h.file).mode & 0o777, 0o600);
      const database = new DatabaseSync(h.file);
      for (const table of ['readonly_model_preflight_tasks', 'readonly_model_preflight_approvals', 'readonly_model_preflight_attempts']) {
        const records = database.prepare(`SELECT payload FROM ${table}`).all();
        const text = records.map((item) => String(item.payload)).join('\n');
        assert.ok(!text.includes(planned.payload!.context.evidence[0]!.excerpt));
        assert.ok(!text.includes(planned.payload!.repository.sourceRoot));
        assert.ok(!text.includes('inputText'));
      }
      database.close();
    } finally { await h.close(); }
  });
}

test('readonly model preflight owner, explicit approval TTL, plan hash, live and old-policy boundaries', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    for (const ttl of [undefined, 0, 61, 1.5, '10', null]) {
      assert.throws(() => h.service.approve({ ...request(plan), expiresInMinutes: ttl as number }, h.ctx), code('READONLY_MODEL_PREFLIGHT_INVALID_APPROVAL'));
    }
    assert.throws(() => h.service.approve({ ...request(plan), planHash: 'a'.repeat(64), expiresInMinutes: 2 }, h.ctx), code('READONLY_MODEL_PREFLIGHT_PLAN_HASH_MISMATCH'));
    assert.throws(() => h.service.approve({ ...request(plan), expiresInMinutes: 2 }, { ...h.ctx, ownerId: `os-user:${process.getuid!() + 1}` }), code('READONLY_MODEL_PREFLIGHT_OWNER_MISMATCH'));
    const approval = approve(h, plan, 1);
    assert.throws(() => approve(h, plan), code('READONLY_MODEL_PREFLIGHT_NOT_READY'));
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), 60_000);
    const later = context(h.ctx.now.getTime() + 60_000);
    assert.equal(h.service.inspect(plan.task.investigationId, later).task.status, 'AWAITING_APPROVAL');
    assert.throws(() => h.store.claim(request(plan), later), code('READONLY_MODEL_PREFLIGHT_APPROVAL_REQUIRED'));
    assert.equal(h.service.inspect(plan.task.investigationId, later).approvals[0]?.revokedAt, later.now.toISOString());
    assert.throws(() => new ReadonlyModelPreflightService(h.store, { mode: 'live' } as unknown as ReadonlyModelPreflightPort, h.directory), code('READONLY_MODEL_PREFLIGHT_LIVE_DISABLED'));
    assert.throws(() => h.store.create({ ...plan.task.plan, policy: 'synthetic-codex-proposal-v1' } as never, plan.payload!, later));
    assert.equal(h.received.length, 0);
  } finally { await h.close(); }
});

test('readonly model preflight concurrent run calls consume one approval and dispatch once', async () => {
  let calls = 0;
  let release: (value: ReadonlyModelPreflightDecodedResponse) => void = () => {};
  let captured: ReadonlyModelPreflightDispatch | null = null;
  const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async (input) => { calls++; captured = input; return new Promise((resolve) => { release = resolve; }); } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const first = h.service.run(request(plan), h.ctx);
    const second = h.service.run(request(plan), h.ctx);
    const rejected = Promise.allSettled([first, second]);
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    release(respond(captured!));
    const results = await rejected;
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(calls, 1);
    const stored = h.service.inspect(plan.task.investigationId, h.ctx);
    assert.equal(stored.attempt?.status, 'REPORTED');
    assert.ok(stored.approvals[0]?.usedAt);
  } finally { await h.close(); }
});

test('readonly model preflight cancellation and invalidation suppress late successful responses', async () => {
  for (const operation of ['cancel', 'invalidate'] as const) {
    let release: (value: ReadonlyModelPreflightDecodedResponse) => void = () => {};
    let captured: ReadonlyModelPreflightDispatch | null = null;
    const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async (input) => { captured = input; return new Promise((resolve) => { release = resolve; }); } });
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      const running = h.service.run(request(plan), h.ctx);
      while (!captured) await new Promise((resolve) => setTimeout(resolve, 5));
      const cancelled = h.service[operation](plan.task.investigationId, h.ctx);
      release(respond(captured!));
      const finished = await running;
      assert.equal(finished.task.status, 'CANCELLED');
      assert.equal(finished.task.generation, 1);
      assert.equal(finished.task.terminalAt, cancelled.task.terminalAt);
      assert.equal(finished.report, null);
      assert.equal(finished.task.reportHash, null);
      assert.ok(finished.approvals[0]?.usedAt);
      await assertReadonlyRepository(plan.payload!.repository);
    } finally { await h.close(); }
  }
});

test('readonly model preflight uncertain cleanup is BLOCKED without restoring consumed approval', async () => {
  let started = false;
  const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async () => { started = true; return new Promise<ReadonlyModelPreflightDecodedResponse>(() => {}); } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const running = h.service.run(request(plan), h.ctx);
    while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelled = h.service.cancel(plan.task.investigationId, h.ctx);
    const finished = await running;
    assert.equal(finished.task.status, 'BLOCKED');
    assert.equal(finished.task.failureCode, 'READONLY_MODEL_PREFLIGHT_RECOVERY_UNCERTAIN');
    assert.equal(finished.task.terminalAt, cancelled.task.terminalAt);
    assert.equal(finished.report, null);
    assert.ok(finished.approvals[0]?.usedAt);
  } finally { await h.close(); }
});

test('readonly model preflight cancellation before dispatch keeps reserved attempt but invokes no model', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const attempt = h.store.claim(request(plan), h.ctx);
    h.store.cancel(plan.task.investigationId, h.ctx);
    let calls = 0;
    assert.throws(() => h.store.dispatch(plan.task.investigationId, attempt.generation, h.ctx, () => { calls++; }), code('READONLY_MODEL_PREFLIGHT_CANCELLED'));
    assert.equal(calls, 0);
    assert.ok(h.store.inspect(plan.task.investigationId, h.ctx).approvals[0]?.usedAt);
  } finally { await h.close(); }
});

test('readonly model preflight DB failure rolls back claim and makes no model call', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const database = new DatabaseSync(h.file);
    database.exec("CREATE TRIGGER reject_readonly_model_preflight_attempt BEFORE INSERT ON readonly_model_preflight_attempts BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await assert.rejects(h.service.run(request(plan), h.ctx));
    assert.equal(h.received.length, 0);
    const snapshot = h.store.inspect(plan.task.investigationId, h.ctx);
    assert.equal(snapshot.task.status, 'APPROVED');
    assert.equal(snapshot.approvals[0]?.usedAt, null);
    assert.equal(snapshot.attempt, null);
    assert.equal(database.prepare('SELECT consumed FROM readonly_model_preflight_markers').get()!.consumed, 0);
    database.close();
  } finally { await h.close(); }
});

test('readonly model preflight modified source and recomputed payload tamper cannot consume approval', async () => {
  for (const tamper of ['source', 'payload', 'plan', 'approval'] as const) {
    const h = await setup();
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      if (tamper === 'source') {
        chmodSync(join(plan.payload!.repository.sourceRoot, 'src/controller.ts'), 0o600);
        await writeFile(join(plan.payload!.repository.sourceRoot, 'src/controller.ts'), 'synthetic changed\n');
      } else {
        const database = new DatabaseSync(h.file);
        if (tamper === 'payload') {
          const row = database.prepare('SELECT payload FROM readonly_model_preflight_payloads').get()!;
          const record = JSON.parse(String(row.payload));
          record.payload.inputText += '\nnot approved';
          record.payload.inputHash = createHash('sha256').update(record.payload.inputText).digest('hex');
          const text = JSON.stringify(record);
          database.prepare('UPDATE readonly_model_preflight_payloads SET payload = ?, payload_hash = ?').run(text, createHash('sha256').update(text).digest('hex'));
        } else if (tamper === 'plan') {
          const row = database.prepare('SELECT payload FROM readonly_model_preflight_tasks').get()!;
          const record = JSON.parse(String(row.payload));
          record.plan.destination = 'https://unapproved.invalid';
          database.prepare('UPDATE readonly_model_preflight_tasks SET payload = ?').run(JSON.stringify(record));
        } else {
          const row = database.prepare('SELECT payload FROM readonly_model_preflight_approvals').get()!;
          const record = JSON.parse(String(row.payload));
          record.planSnapshot.writeAllowedFiles = ['src/controller.ts'];
          database.prepare('UPDATE readonly_model_preflight_approvals SET payload = ?').run(JSON.stringify(record));
        }
        database.close();
      }
      await assert.rejects(h.service.run(request(plan), h.ctx));
      assert.equal(h.received.length, 0);
      const database = new DatabaseSync(h.file);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM readonly_model_preflight_attempts').get()!.count, 0);
      assert.equal(database.prepare('SELECT used_at FROM readonly_model_preflight_approvals').get()!.used_at, null);
      database.close();
    } finally { await h.close(); }
  }
});

test('readonly model preflight source changed during model response cannot produce a successful report', async () => {
  let sourceRoot = '';
  const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async (input) => {
    chmodSync(join(sourceRoot, 'src/service.ts'), 0o600);
    await writeFile(join(sourceRoot, 'src/service.ts'), 'synthetic changed after dispatch\n');
    return respond(input);
  } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    sourceRoot = plan.payload!.repository.sourceRoot;
    approve(h, plan);
    const finished = await h.service.run(request(plan), h.ctx);
    assert.equal(finished.task.status, 'BLOCKED');
    assert.equal(finished.task.failureCode, 'READONLY_MODEL_PREFLIGHT_SOURCE_CHANGED');
    assert.equal(finished.report, null);
    await assert.rejects(h.service.run(request(plan), h.ctx));
  } finally { await h.close(); }
});

test('readonly model preflight raw failures and invalid model output are static and never retried', async () => {
  for (const response of ['throw', 'malformed', 'oversize'] as const) {
    let calls = 0;
    const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async () => {
      calls++;
      if (response === 'throw') throw new Error('synthetic-private-error-body');
      return { text: response === 'oversize' ? 'x'.repeat(16_385) : '{"command":"run-it"}', responseHash: 'a'.repeat(64) };
    } });
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      const result = await h.service.run(request(plan), h.ctx);
      assert.equal(result.task.status, 'FAILED');
      assert.equal(result.report, null);
      assert.ok(!JSON.stringify(result).includes('synthetic-private-error-body'));
      await assert.rejects(h.service.run(request(plan), h.ctx));
      assert.equal(calls, 1);
      await assertReadonlyRepository(plan.payload!.repository);
    } finally { await h.close(); }
  }
});

test('readonly model preflight restart preserves RUNNING and explicit recovery never resumes', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    h.store.claim(request(plan), h.ctx);
    const fresh = new SqliteReadonlyModelPreflightStore(h.file);
    try {
      assert.equal(fresh.inspect(plan.task.investigationId, h.ctx).task.status, 'RUNNING');
      const recovered = fresh.recover(plan.task.investigationId, h.ctx, true);
      assert.equal(recovered.task.status, 'INTERRUPTED');
      assert.equal(recovered.task.generation, 1);
      assert.ok(recovered.approvals[0]?.usedAt);
      assert.throws(() => fresh.claim(request(plan), h.ctx));
      assert.equal(fresh.recover(plan.task.investigationId, context(h.ctx.now.getTime() + 1000), true).task.terminalAt, recovered.task.terminalAt);
      assert.equal(h.received.length, 0);
    } finally { fresh.close(); }
  } finally { await h.close(); }
});

test('readonly model preflight payload expires at 24h, first terminal audit at 30d, markers remain', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const finished = await h.service.run(request(plan), h.ctx);
    const expired = context(Date.parse(plan.task.plan.expiresAt));
    const inspection = h.service.inspect(plan.task.investigationId, expired);
    assert.equal(inspection.task.status, 'REPORTED');
    assert.equal(inspection.payload, null);
    assert.equal(inspection.report, null);
    assert.equal(inspection.payloadExpired, true);
    assert.equal(inspection.task.terminalAt, finished.task.terminalAt);
    assert.equal((await h.service.recover(plan.task.investigationId, expired)).task.terminalAt, finished.task.terminalAt);
    await assert.rejects(h.service.run(request(plan), expired));
    const purged = context(Date.parse(finished.task.terminalAt!) + 30 * 86_400_000);
    assert.equal(h.service.prune(purged).auditsRemoved, 1);
    assert.throws(() => h.service.inspect(plan.task.investigationId, purged), code('READONLY_MODEL_PREFLIGHT_NOT_FOUND'));
    const database = new DatabaseSync(h.file);
    assert.equal(database.prepare('SELECT consumed FROM readonly_model_preflight_markers').get()!.consumed, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM readonly_model_preflight_payloads').get()!.count, 0);
    database.close();
    assert.throws(() => h.store.create(plan.task.plan, plan.payload!, h.ctx), code('READONLY_MODEL_PREFLIGHT_ID_REUSED'));
  } finally { await h.close(); }
});

test('readonly model preflight RUNNING is not auto recovered/pruned; expired late output cannot restore payload', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const attempt = h.store.claim(request(plan), h.ctx);
    const expired = context(Date.parse(plan.task.plan.expiresAt));
    assert.equal(h.store.inspect(plan.task.investigationId, expired).task.status, 'RUNNING');
    const muchLater = context(expired.now.getTime() + 31 * 86_400_000);
    assert.equal(h.store.prune(muchLater).auditsRemoved, 0);
    const finished = h.store.finish(plan.task.investigationId, attempt.generation, null, 'READONLY_MODEL_PREFLIGHT_CALL_FAILED', muchLater);
    assert.equal(finished.task.status, 'FAILED');
    assert.equal(finished.task.failureCode, 'READONLY_MODEL_PREFLIGHT_EXPIRED');
    assert.equal(finished.payload, null);
    assert.equal(finished.report, null);
    assert.equal(h.store.prune(muchLater).auditsRemoved, 0);
  } finally { await h.close(); }
});

test('readonly model preflight stale caller clock cannot bypass approval expiry at dispatch', async () => {
  const h = await setup();
  const originalNow = Date.now;
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan, 1);
    const attempt = h.store.claim(request(plan), h.ctx);
    let calls = 0;
    Date.now = () => h.ctx.now.getTime() + 60_000;
    assert.throws(() => h.store.dispatch(plan.task.investigationId, attempt.generation, h.ctx, () => { calls++; }), code('READONLY_MODEL_PREFLIGHT_EXPIRED'));
    assert.equal(calls, 0);
  } finally { Date.now = originalNow; await h.close(); }
});

test('readonly model preflight 55-second service deadline aborts once and never retries', async (t) => {
  let calls = 0;
  const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async (_input, signal) => {
    calls++;
    return new Promise<ReadonlyModelPreflightDecodedResponse>((_resolve, reject) => signal.addEventListener('abort', () => reject(new HarnessError('READONLY_MODEL_PREFLIGHT_TIMEOUT')), { once: true }));
  } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const running = h.service.run(request(plan), h.ctx);
    while (calls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(55_000);
    const result = await running;
    t.mock.timers.reset();
    assert.equal(result.task.status, 'FAILED');
    assert.equal(result.task.failureCode, 'READONLY_MODEL_PREFLIGHT_TIMEOUT');
    assert.equal(result.report, null);
    assert.equal(calls, 1);
    await assert.rejects(h.service.run(request(plan), h.ctx));
    assert.equal(calls, 1);
  } finally { t.mock.timers.reset(); await h.close(); }
});

test('readonly model preflight strict stored records reject malformed lifecycle and payload fields', async () => {
  for (const tamper of ['generation', 'attempt', 'approval', 'marker', 'expiry'] as const) {
    const h = await setup();
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      h.store.claim(request(plan), h.ctx);
      const database = new DatabaseSync(h.file);
      if (tamper === 'marker') database.exec('UPDATE readonly_model_preflight_markers SET consumed = 0');
      else if (tamper === 'expiry') database.prepare('UPDATE readonly_model_preflight_payloads SET expires_at = ?').run(h.ctx.now.toISOString());
      else {
        const table = tamper === 'generation' ? 'readonly_model_preflight_tasks' : tamper === 'attempt' ? 'readonly_model_preflight_attempts' : 'readonly_model_preflight_approvals';
        const row = database.prepare(`SELECT payload FROM ${table}`).get()!;
        const record = JSON.parse(String(row.payload));
        if (tamper === 'generation') record.generation = 2;
        else if (tamper === 'attempt') record.command = 'unapproved';
        else record.usedAt = null;
        database.prepare(`UPDATE ${table} SET payload = ?`).run(JSON.stringify(record));
      }
      database.close();
      assert.throws(() => h.service.inspect(plan.task.investigationId, h.ctx), code('READONLY_MODEL_PREFLIGHT_INVALID_RECORD'));
      assert.equal(h.received.length, 0);
    } finally { await h.close(); }
  }
});

test('readonly model preflight rejects unsafe private database permission and links', async () => {
  const h = await setup();
  try {
    chmodSync(h.file, 0o644);
    assert.throws(() => h.store.inspect('bad-id', h.ctx), code('UNSAFE_RUNTIME_FILE'));
    chmodSync(h.file, 0o600);
    assert.throws(() => new SqliteReadonlyModelPreflightStore('relative.sqlite'), code('UNSAFE_RUNTIME_PATH'));
  } finally { await h.close(); }
});

test('readonly model preflight recovery requires both unchanged source and proven cleanup', async () => {
  for (const condition of ['unchanged', 'changed', 'expired'] as const) {
    const h = await setup();
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      h.store.claim(request(plan), h.ctx);
      const service = new ReadonlyModelPreflightService(h.store, { mode: 'offline', transport: 'in-memory-fake', transmit: async () => { throw new Error('must not run'); } }, h.directory, () => true);
      if (condition === 'changed') {
        chmodSync(join(plan.payload!.repository.sourceRoot, 'src/controller.ts'), 0o600);
        await writeFile(join(plan.payload!.repository.sourceRoot, 'src/controller.ts'), 'synthetic changed before recovery\n');
      }
      const recoveryContext = condition === 'expired' ? context(Date.parse(plan.task.plan.expiresAt)) : h.ctx;
      const recovered = await service.recover(plan.task.investigationId, recoveryContext);
      assert.equal(recovered.task.status, condition === 'unchanged' ? 'INTERRUPTED' : 'BLOCKED');
      assert.equal(recovered.report, null);
      assert.equal(h.received.length, 0);
    } finally { await h.close(); }
  }
});

test('135 offline service rejects missing, legacy and non-fake transports without fallback', async () => {
  const h = await setup();
  try {
    for (const port of [undefined, {}, { mode: 'mock', investigate: async () => '' },
      { mode: 'offline', transport: 'network', transmit: async () => ({ text: '', responseHash: '' }) },
      { mode: 'live', transport: 'in-memory-fake', transmit: async () => ({ text: '', responseHash: '' }) }]) {
      assert.throws(() => new ReadonlyModelPreflightService(h.store, port as unknown as ReadonlyModelPreflightPort, h.directory), code('READONLY_MODEL_PREFLIGHT_LIVE_DISABLED'));
    }
    await assert.rejects(h.service.plan('flow', undefined, h.ctx, 'all', 'live' as never));
    assert.equal(h.received.length, 0);
    assert.deepEqual(await readdir(h.directory), ['readonly-model-preflights.sqlite']);
  } finally { await h.close(); }
});

test('139/141/149 SSE profile binds final request bytes and stores an offline report only', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', defaultReadonlySelection('change-request'), h.ctx, 'service', 'responses-candidate-sse-v1');
    approve(h, plan);
    const result = await h.service.run(request(plan), h.ctx);
    assert.equal(result.task.status, 'REPORTED');
    assert.deepEqual(h.received[0]!.requestEnvelope, plan.payload!.requestEnvelope);
    assert.equal(result.attempt!.requestBodyHash, plan.task.plan.requestBodyHash);
    assert.equal(result.attempt!.inputHash, plan.task.plan.inputHash);
    assert.equal(result.attempt!.connectionProfileHash, plan.task.plan.connectionProfileHash);
    assert.equal(result.attempt!.requestEnvelopeHash, plan.task.plan.requestEnvelopeHash);
    assert.equal(result.attempt!.configHash, plan.task.plan.configHash);
    assert.notEqual(plan.task.plan.inputHash, plan.task.plan.requestBodyHash);
    assert.equal(result.report!.mode, 'offline');
    assert.equal(result.report!.transport, 'in-memory-fake');
    assert.equal(result.report!.responseOrigin, 'synthetic');
    assert.equal(result.report!.excludedOperationsReason, 'offline-fake-only');
    assert.equal(result.report!.checks.credentialAccess, 'not_run');
    assert.equal(result.report!.checks.providerCompatibility, 'not_run');
    assert.equal(result.report!.requestBodyHash, plan.task.plan.requestBodyHash);
    assert.equal(result.report!.result.facts.length, 1);
    assert.equal(result.report!.liveReady, false);
    assert.deepEqual(result.report!.offlineContractVerified, { profile: 'passed', envelope: 'passed', response: 'passed', evidence: 'passed' });
    assert.equal(result.report!.checks.liveIsolation, 'not_run');
    assert.equal(result.report!.checks.semanticAccuracy, 'not_run');
    assert.equal(result.report!.connectionProfileHash, plan.task.plan.connectionProfileHash);
    assert.equal(result.report!.requestEnvelopeHash, plan.task.plan.requestEnvelopeHash);
    await assertReadonlyRepository(plan.payload!.repository);
  } finally { await h.close(); }
});

test('139/140 modified final request and recomputed payload hash cannot consume approval', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const database = new DatabaseSync(h.file);
    const stored = database.prepare('SELECT payload FROM readonly_model_preflight_payloads').get()!;
    const payload = JSON.parse(String(stored.payload));
    payload.payload.requestBody += ' ';
    payload.payload.requestBodyHash = createHash('sha256').update(payload.payload.requestBody).digest('hex');
    const text = JSON.stringify(payload);
    database.prepare('UPDATE readonly_model_preflight_payloads SET payload = ?, payload_hash = ?').run(text, createHash('sha256').update(text).digest('hex'));
    await assert.rejects(h.service.run(request(plan), h.ctx));
    assert.equal(h.received.length, 0);
    assert.equal(database.prepare('SELECT consumed FROM readonly_model_preflight_markers').get()!.consumed, 0);
    assert.equal(database.prepare('SELECT used_at FROM readonly_model_preflight_approvals').get()!.used_at, null);
    database.close();
  } finally { await h.close(); }
});

test('141 dispatch reservation storage failure makes zero fake calls and retains consumed approval', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const attempt = h.store.claim(request(plan), h.ctx);
    const database = new DatabaseSync(h.file);
    database.exec("CREATE TRIGGER reject_transport_dispatch BEFORE UPDATE ON readonly_model_preflight_attempts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    let calls = 0;
    assert.throws(() => h.store.dispatch(plan.task.investigationId, attempt.generation, h.ctx, () => { calls++; }));
    assert.equal(calls, 0);
    assert.equal(database.prepare('SELECT consumed FROM readonly_model_preflight_markers').get()!.consumed, 1);
    assert.ok(database.prepare('SELECT used_at FROM readonly_model_preflight_approvals').get()!.used_at);
    database.close();
    await assert.rejects(h.service.run(request(plan), h.ctx));
  } finally { await h.close(); }
});

test('143 rejected raw and partial responses never enter private payloads or audit records', async () => {
  const raw = 'SYNTHETIC_REJECTED_RAW_CANARY';
  for (const value of [Buffer.from('{"unexpected":"' + raw + '"}'), Buffer.from('{"partial":"' + raw), Buffer.from([0xc3, 0x28])]) {
    let calls = 0;
    const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async () => { calls++; return { text: value.toString('utf8'), responseHash: createHash('sha256').update(value).digest('hex') }; } });
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      const result = await h.service.run(request(plan), h.ctx);
      assert.equal(result.task.status, 'FAILED');
      assert.equal(result.report, null);
      assert.equal(result.attempt!.responseHash, null);
      assert.equal(JSON.stringify(result).includes(raw), false);
      const database = new DatabaseSync(h.file);
      for (const table of ['readonly_model_preflight_tasks', 'readonly_model_preflight_payloads', 'readonly_model_preflight_approvals', 'readonly_model_preflight_attempts']) {
        for (const row of database.prepare(`SELECT payload FROM ${table}`).all()) assert.equal(String(row.payload).includes(raw), false);
      }
      database.close();
      await assert.rejects(h.service.run(request(plan), h.ctx));
      assert.equal(calls, 1);
    } finally { await h.close(); }
  }
});

test('146 cancellation plus source mutation remains blocked and retains first terminal timestamp', async () => {
  let release: (value: ReadonlyModelPreflightDecodedResponse) => void = () => {};
  let body: ReadonlyModelPreflightDispatch | null = null;
  const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async (input) => {
    body = input; return new Promise<ReadonlyModelPreflightDecodedResponse>((resolve) => { release = resolve; });
  } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const running = h.service.run(request(plan), h.ctx);
    while (!body) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelled = h.service.cancel(plan.task.investigationId, h.ctx);
    const sourceFile = join(plan.payload!.repository.sourceRoot, 'src/service.ts');
    chmodSync(sourceFile, 0o600);
    await writeFile(sourceFile, 'synthetic changed during cancellation\n');
    release(respond(body!));
    const result = await running;
    assert.equal(result.task.status, 'BLOCKED');
    assert.equal(result.task.failureCode, 'READONLY_MODEL_PREFLIGHT_SOURCE_CHANGED');
    assert.equal(result.task.terminalAt, cancelled.task.terminalAt);
    assert.equal(result.report, null);
  } finally { await h.close(); }
});

test('147 attempt request body hash cannot be changed independently of the approved plan', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    h.store.claim(request(plan), h.ctx);
    const database = new DatabaseSync(h.file);
    const row = database.prepare('SELECT payload FROM readonly_model_preflight_attempts').get()!;
    const attempt = JSON.parse(String(row.payload));
    attempt.requestBodyHash = '0'.repeat(64);
    database.prepare('UPDATE readonly_model_preflight_attempts SET payload = ?').run(JSON.stringify(attempt));
    database.close();
    await assert.rejects(h.service.recover(plan.task.investigationId, h.ctx), code('READONLY_MODEL_PREFLIGHT_INVALID_RECORD'));
    assert.equal(h.received.length, 0);
  } finally { await h.close(); }
});

test('139/140 a changed method, destination, headers or profile cannot reuse body approval after rehashing', async () => {
  for (const field of ['method', 'url', 'headers', 'connectionProfileHash', 'profileId'] as const) {
    const h = await setup();
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      const database = new DatabaseSync(h.file);
      const stored = database.prepare('SELECT payload FROM readonly_model_preflight_payloads').get()!;
      const record = JSON.parse(String(stored.payload));
      const envelope = record.payload.requestEnvelope;
      if (field === 'headers') envelope.headers = [['accept', 'text/event-stream'], ['content-type', 'application/json']];
      else envelope[field] = field === 'method' ? 'GET' : field === 'url' ? 'https://different.invalid/v1/responses'
        : field === 'profileId' ? 'responses-candidate-sse-v1' : '0'.repeat(64);
      record.payload.requestEnvelopeHash = hashReadonlyModelPreflightEnvelope(envelope);
      const text = JSON.stringify(record);
      database.prepare('UPDATE readonly_model_preflight_payloads SET payload = ?, payload_hash = ?').run(text, createHash('sha256').update(text).digest('hex'));
      await assert.rejects(h.service.run(request(plan), h.ctx));
      assert.equal(h.received.length, 0);
      assert.equal(database.prepare('SELECT consumed FROM readonly_model_preflight_markers').get()!.consumed, 0);
      assert.equal(database.prepare('SELECT used_at FROM readonly_model_preflight_approvals').get()!.used_at, null);
      database.close();
    } finally { await h.close(); }
  }
});

test('147 recovery is bound to body, envelope and profile hashes and does not dispatch', async () => {
  for (const field of ['requestBodyHash', 'requestEnvelopeHash', 'connectionProfileHash'] as const) {
    const h = await setup();
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      h.store.claim(request(plan), h.ctx);
      let checks = 0;
      const service = new ReadonlyModelPreflightService(h.store, { mode: 'offline', transport: 'in-memory-fake', transmit: async () => { throw new Error('no dispatch'); } }, h.directory,
        (id, hashes) => {
          checks++;
          assert.equal(id, plan.task.investigationId);
          assert.deepEqual(hashes, { requestBodyHash: plan.task.plan.requestBodyHash, requestEnvelopeHash: plan.task.plan.requestEnvelopeHash,
            connectionProfileHash: plan.task.plan.connectionProfileHash });
          return hashes[field] === '0'.repeat(64);
        });
      const recovered = await service.recover(plan.task.investigationId, h.ctx);
      assert.equal(recovered.task.status, 'BLOCKED');
      assert.equal(checks, 1);
      assert.equal(h.received.length, 0);
      assert.ok(recovered.approvals[0]!.usedAt);
    } finally { await h.close(); }
  }
});

test('147 attempt profile or envelope hash tampering is rejected after restart', async () => {
  for (const field of ['requestEnvelopeHash', 'connectionProfileHash'] as const) {
    const h = await setup();
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      h.store.claim(request(plan), h.ctx);
      const database = new DatabaseSync(h.file);
      const row = database.prepare('SELECT payload FROM readonly_model_preflight_attempts').get()!;
      const attempt = JSON.parse(String(row.payload));
      attempt[field] = '0'.repeat(64);
      database.prepare('UPDATE readonly_model_preflight_attempts SET payload = ?').run(JSON.stringify(attempt));
      database.close();
      const fresh = new SqliteReadonlyModelPreflightStore(h.file);
      try { assert.throws(() => fresh.recover(plan.task.investigationId, h.ctx, true), code('READONLY_MODEL_PREFLIGHT_INVALID_RECORD')); }
      finally { fresh.close(); }
      assert.equal(h.received.length, 0);
    } finally { await h.close(); }
  }
});

test('146 uncertain worker closure is BLOCKED even when the fake rejects promptly', async () => {
  const h = await setup({ mode: 'offline', transport: 'in-memory-fake', transmit: async () => { throw new HarnessError('READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE'); } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const result = await h.service.run(request(plan), h.ctx);
    assert.equal(result.task.status, 'BLOCKED');
    assert.equal(result.task.failureCode, 'READONLY_MODEL_PREFLIGHT_RECOVERY_UNCERTAIN');
    assert.equal(result.report, null);
    assert.ok(result.approvals[0]!.usedAt);
    await assert.rejects(h.service.run(request(plan), h.ctx));
  } finally { await h.close(); }
});

test('149 accepted report cannot be relabelled live-ready even with recomputed payload hashes', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    await h.service.run(request(plan), h.ctx);
    const database = new DatabaseSync(h.file);
    const row = database.prepare('SELECT payload FROM readonly_model_preflight_payloads').get()!;
    const record = JSON.parse(String(row.payload));
    record.report.liveReady = true;
    const text = JSON.stringify(record);
    database.prepare('UPDATE readonly_model_preflight_payloads SET payload = ?, payload_hash = ?').run(text, createHash('sha256').update(text).digest('hex'));
    database.close();
    assert.throws(() => h.service.inspect(plan.task.investigationId, h.ctx), code('READONLY_MODEL_PREFLIGHT_INVALID_RECORD'));
  } finally { await h.close(); }
});
