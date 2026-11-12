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
import type { ReadonlyModelPort, ReadonlySnapshot } from '../src/ports/readonly-investigation.js';
import { SqliteReadonlyInvestigationStore } from '../src/adapters/sqlite-readonly-investigation-store.js';
import { ReadonlyInvestigationService } from '../src/application/investigate-readonly.js';
import { assertReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { buildReadonlyMockResponse, defaultReadonlySelection } from '../src/policy/readonly-investigation-policy.js';

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
const setup = async (port?: ReadonlyModelPort) => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'readonly-lifecycle-')));
  chmodSync(directory, 0o700);
  const file = join(directory, 'readonly-investigations.sqlite');
  const store = new SqliteReadonlyInvestigationStore(file);
  const received: string[] = [];
  const model: ReadonlyModelPort = port ?? { mode: 'mock', investigate: async (input) => { received.push(input); return buildReadonlyMockResponse(input); } };
  const service = new ReadonlyInvestigationService(store, model, directory);
  const ctx = context();
  return { directory, file, store, service, received, ctx, close: async () => { store.close(); await removeFixture(directory); } };
};
const request = (snapshot: ReadonlySnapshot) => ({ investigationId: snapshot.task.investigationId, planHash: snapshot.task.plan.planHash });
const approve = (h: Awaited<ReturnType<typeof setup>>, snapshot: ReadonlySnapshot, expiresInMinutes = 60) => h.service.approve({ ...request(snapshot), expiresInMinutes }, h.ctx);

for (const requestId of ['flow-question', 'change-request'] as const) {
  test(`readonly lifecycle: ${requestId} reports approved bytes without execution`, async () => {
    const h = await setup();
    try {
      const planned = await h.service.plan('flow', defaultReadonlySelection(requestId), h.ctx, 'controller');
      assert.equal(h.received.length, 0);
      assert.equal(planned.payload!.context.evidence.length, 4);
      assert.equal(planned.task.plan.transferEvidenceIds.length, 1);
      await assert.rejects(h.service.run(request(planned), h.ctx), code('READONLY_APPROVAL_REQUIRED'));
      assert.equal(h.received.length, 0);
      approve(h, planned);
      const finished = await h.service.run(request(planned), h.ctx);
      assert.equal(finished.task.status, 'REPORTED');
      assert.equal(h.received.length, 1);
      assert.equal(h.received[0], planned.payload!.inputText);
      assert.equal(createHash('sha256').update(h.received[0]!).digest('hex'), planned.task.plan.inputHash);
      assert.equal(finished.report?.mode, 'mock');
      assert.equal(finished.report?.checks.realModel, 'not_run');
      assert.equal(finished.report?.checks.targetCodeExecution, 'not_run');
      assert.equal(finished.report?.semanticAccuracyVerified, false);
      assert.deepEqual(finished.task.plan.writeAllowedFiles, []);
      assert.deepEqual(finished.task.plan.testCommandIds, []);
      assert.equal(finished.task.plan.executionAllowed, false);
      assert.equal('consumeForExecution' in h.service, false);
      assert.ok(!h.received[0]!.includes(planned.payload!.repository.sourceRoot));
      await assertReadonlyRepository(planned.payload!.repository);
      await assert.rejects(h.service.run(request(planned), h.ctx));
      assert.equal(h.received.length, 1);
      assert.equal(statSync(h.file).mode & 0o777, 0o600);
      const database = new DatabaseSync(h.file);
      for (const table of ['readonly_tasks', 'readonly_approvals', 'readonly_attempts']) {
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

test('readonly owner, explicit approval TTL, plan hash, live and old-policy boundaries', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    for (const ttl of [undefined, 0, 61, 1.5, '10', null]) {
      assert.throws(() => h.service.approve({ ...request(plan), expiresInMinutes: ttl as number }, h.ctx), code('READONLY_INVALID_APPROVAL'));
    }
    assert.throws(() => h.service.approve({ ...request(plan), planHash: 'a'.repeat(64), expiresInMinutes: 2 }, h.ctx), code('READONLY_PLAN_HASH_MISMATCH'));
    assert.throws(() => h.service.approve({ ...request(plan), expiresInMinutes: 2 }, { ...h.ctx, ownerId: `os-user:${process.getuid!() + 1}` }), code('READONLY_OWNER_MISMATCH'));
    const approval = approve(h, plan, 1);
    assert.throws(() => approve(h, plan), code('READONLY_NOT_READY'));
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), 60_000);
    const later = context(h.ctx.now.getTime() + 60_000);
    assert.equal(h.service.inspect(plan.task.investigationId, later).task.status, 'AWAITING_APPROVAL');
    assert.throws(() => h.store.claim(request(plan), later), code('READONLY_APPROVAL_REQUIRED'));
    assert.equal(h.service.inspect(plan.task.investigationId, later).approvals[0]?.revokedAt, later.now.toISOString());
    assert.throws(() => new ReadonlyInvestigationService(h.store, { mode: 'live' } as unknown as ReadonlyModelPort, h.directory), code('READONLY_LIVE_DISABLED'));
    assert.throws(() => h.store.create({ ...plan.task.plan, policy: 'synthetic-codex-proposal-v1' } as never, plan.payload!, later));
    assert.equal(h.received.length, 0);
  } finally { await h.close(); }
});

test('readonly concurrent run calls consume one approval and dispatch once', async () => {
  let calls = 0;
  let release: (value: string) => void = () => {};
  let captured = '';
  const h = await setup({ mode: 'mock', investigate: async (input) => { calls++; captured = input; return new Promise((resolve) => { release = resolve; }); } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const first = h.service.run(request(plan), h.ctx);
    const second = h.service.run(request(plan), h.ctx);
    const rejected = Promise.allSettled([first, second]);
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    release(buildReadonlyMockResponse(captured));
    const results = await rejected;
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(calls, 1);
    const stored = h.service.inspect(plan.task.investigationId, h.ctx);
    assert.equal(stored.attempt?.status, 'REPORTED');
    assert.ok(stored.approvals[0]?.usedAt);
  } finally { await h.close(); }
});

test('readonly cancellation and invalidation suppress late successful responses', async () => {
  for (const operation of ['cancel', 'invalidate'] as const) {
    let release: (value: string) => void = () => {};
    let captured = '';
    const h = await setup({ mode: 'mock', investigate: async (input) => { captured = input; return new Promise((resolve) => { release = resolve; }); } });
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      const running = h.service.run(request(plan), h.ctx);
      while (!captured) await new Promise((resolve) => setTimeout(resolve, 5));
      const cancelled = h.service[operation](plan.task.investigationId, h.ctx);
      release(buildReadonlyMockResponse(captured));
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

test('readonly uncertain cleanup is BLOCKED without restoring consumed approval', async () => {
  let started = false;
  const h = await setup({ mode: 'mock', investigate: async () => { started = true; return new Promise<string>(() => {}); } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const running = h.service.run(request(plan), h.ctx);
    while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelled = h.service.cancel(plan.task.investigationId, h.ctx);
    const finished = await running;
    assert.equal(finished.task.status, 'BLOCKED');
    assert.equal(finished.task.failureCode, 'READONLY_RECOVERY_UNCERTAIN');
    assert.equal(finished.task.terminalAt, cancelled.task.terminalAt);
    assert.equal(finished.report, null);
    assert.ok(finished.approvals[0]?.usedAt);
  } finally { await h.close(); }
});

test('readonly cancellation before dispatch keeps reserved attempt but invokes no model', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const attempt = h.store.claim(request(plan), h.ctx);
    h.store.cancel(plan.task.investigationId, h.ctx);
    let calls = 0;
    assert.throws(() => h.store.dispatch(plan.task.investigationId, attempt.generation, h.ctx, () => { calls++; }), code('READONLY_CANCELLED'));
    assert.equal(calls, 0);
    assert.ok(h.store.inspect(plan.task.investigationId, h.ctx).approvals[0]?.usedAt);
  } finally { await h.close(); }
});

test('readonly DB failure rolls back claim and makes no model call', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const database = new DatabaseSync(h.file);
    database.exec("CREATE TRIGGER reject_readonly_attempt BEFORE INSERT ON readonly_attempts BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await assert.rejects(h.service.run(request(plan), h.ctx));
    assert.equal(h.received.length, 0);
    const snapshot = h.store.inspect(plan.task.investigationId, h.ctx);
    assert.equal(snapshot.task.status, 'APPROVED');
    assert.equal(snapshot.approvals[0]?.usedAt, null);
    assert.equal(snapshot.attempt, null);
    assert.equal(database.prepare('SELECT consumed FROM readonly_markers').get()!.consumed, 0);
    database.close();
  } finally { await h.close(); }
});

test('readonly modified source and recomputed payload tamper cannot consume approval', async () => {
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
          const row = database.prepare('SELECT payload FROM readonly_payloads').get()!;
          const record = JSON.parse(String(row.payload));
          record.payload.inputText += '\nnot approved';
          record.payload.inputHash = createHash('sha256').update(record.payload.inputText).digest('hex');
          const text = JSON.stringify(record);
          database.prepare('UPDATE readonly_payloads SET payload = ?, payload_hash = ?').run(text, createHash('sha256').update(text).digest('hex'));
        } else if (tamper === 'plan') {
          const row = database.prepare('SELECT payload FROM readonly_tasks').get()!;
          const record = JSON.parse(String(row.payload));
          record.plan.destination = 'https://unapproved.invalid';
          database.prepare('UPDATE readonly_tasks SET payload = ?').run(JSON.stringify(record));
        } else {
          const row = database.prepare('SELECT payload FROM readonly_approvals').get()!;
          const record = JSON.parse(String(row.payload));
          record.planSnapshot.writeAllowedFiles = ['src/controller.ts'];
          database.prepare('UPDATE readonly_approvals SET payload = ?').run(JSON.stringify(record));
        }
        database.close();
      }
      await assert.rejects(h.service.run(request(plan), h.ctx));
      assert.equal(h.received.length, 0);
      const database = new DatabaseSync(h.file);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM readonly_attempts').get()!.count, 0);
      assert.equal(database.prepare('SELECT used_at FROM readonly_approvals').get()!.used_at, null);
      database.close();
    } finally { await h.close(); }
  }
});

test('readonly source changed during model response cannot produce a successful report', async () => {
  let sourceRoot = '';
  const h = await setup({ mode: 'mock', investigate: async (input) => {
    chmodSync(join(sourceRoot, 'src/service.ts'), 0o600);
    await writeFile(join(sourceRoot, 'src/service.ts'), 'synthetic changed after dispatch\n');
    return buildReadonlyMockResponse(input);
  } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    sourceRoot = plan.payload!.repository.sourceRoot;
    approve(h, plan);
    const finished = await h.service.run(request(plan), h.ctx);
    assert.equal(finished.task.status, 'BLOCKED');
    assert.equal(finished.task.failureCode, 'READONLY_SOURCE_CHANGED');
    assert.equal(finished.report, null);
    await assert.rejects(h.service.run(request(plan), h.ctx));
  } finally { await h.close(); }
});

test('readonly raw failures and invalid model output are static and never retried', async () => {
  for (const response of ['throw', 'malformed', 'oversize'] as const) {
    let calls = 0;
    const h = await setup({ mode: 'mock', investigate: async () => {
      calls++;
      if (response === 'throw') throw new Error('synthetic-private-error-body');
      return response === 'oversize' ? 'x'.repeat(16_385) : '{"command":"run-it"}';
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

test('readonly restart preserves RUNNING and explicit recovery never resumes', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    h.store.claim(request(plan), h.ctx);
    const fresh = new SqliteReadonlyInvestigationStore(h.file);
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

test('readonly payload expires at 24h, first terminal audit at 30d, markers remain', async () => {
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
    assert.throws(() => h.service.inspect(plan.task.investigationId, purged), code('READONLY_NOT_FOUND'));
    const database = new DatabaseSync(h.file);
    assert.equal(database.prepare('SELECT consumed FROM readonly_markers').get()!.consumed, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM readonly_payloads').get()!.count, 0);
    database.close();
    assert.throws(() => h.store.create(plan.task.plan, plan.payload!, h.ctx), code('READONLY_ID_REUSED'));
  } finally { await h.close(); }
});

test('readonly RUNNING is not auto recovered/pruned; expired late output cannot restore payload', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    const attempt = h.store.claim(request(plan), h.ctx);
    const expired = context(Date.parse(plan.task.plan.expiresAt));
    assert.equal(h.store.inspect(plan.task.investigationId, expired).task.status, 'RUNNING');
    const muchLater = context(expired.now.getTime() + 31 * 86_400_000);
    assert.equal(h.store.prune(muchLater).auditsRemoved, 0);
    const finished = h.store.finish(plan.task.investigationId, attempt.generation, null, 'READONLY_CALL_FAILED', muchLater);
    assert.equal(finished.task.status, 'FAILED');
    assert.equal(finished.task.failureCode, 'READONLY_EXPIRED');
    assert.equal(finished.payload, null);
    assert.equal(finished.report, null);
    assert.equal(h.store.prune(muchLater).auditsRemoved, 0);
  } finally { await h.close(); }
});

test('readonly stale caller clock cannot bypass approval expiry at dispatch', async () => {
  const h = await setup();
  const originalNow = Date.now;
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan, 1);
    const attempt = h.store.claim(request(plan), h.ctx);
    let calls = 0;
    Date.now = () => h.ctx.now.getTime() + 60_000;
    assert.throws(() => h.store.dispatch(plan.task.investigationId, attempt.generation, h.ctx, () => { calls++; }), code('READONLY_EXPIRED'));
    assert.equal(calls, 0);
  } finally { Date.now = originalNow; await h.close(); }
});

test('readonly 60-second service deadline aborts once and never retries', async (t) => {
  let calls = 0;
  const h = await setup({ mode: 'mock', investigate: async (_input, signal) => {
    calls++;
    return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new HarnessError('READONLY_TIMEOUT')), { once: true }));
  } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx);
    approve(h, plan);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const running = h.service.run(request(plan), h.ctx);
    while (calls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(60_000);
    const result = await running;
    t.mock.timers.reset();
    assert.equal(result.task.status, 'FAILED');
    assert.equal(result.task.failureCode, 'READONLY_TIMEOUT');
    assert.equal(result.report, null);
    assert.equal(calls, 1);
    await assert.rejects(h.service.run(request(plan), h.ctx));
    assert.equal(calls, 1);
  } finally { t.mock.timers.reset(); await h.close(); }
});

test('readonly strict stored records reject malformed lifecycle and payload fields', async () => {
  for (const tamper of ['generation', 'attempt', 'approval', 'marker', 'expiry'] as const) {
    const h = await setup();
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      h.store.claim(request(plan), h.ctx);
      const database = new DatabaseSync(h.file);
      if (tamper === 'marker') database.exec('UPDATE readonly_markers SET consumed = 0');
      else if (tamper === 'expiry') database.prepare('UPDATE readonly_payloads SET expires_at = ?').run(h.ctx.now.toISOString());
      else {
        const table = tamper === 'generation' ? 'readonly_tasks' : tamper === 'attempt' ? 'readonly_attempts' : 'readonly_approvals';
        const row = database.prepare(`SELECT payload FROM ${table}`).get()!;
        const record = JSON.parse(String(row.payload));
        if (tamper === 'generation') record.generation = 2;
        else if (tamper === 'attempt') record.command = 'unapproved';
        else record.usedAt = null;
        database.prepare(`UPDATE ${table} SET payload = ?`).run(JSON.stringify(record));
      }
      database.close();
      assert.throws(() => h.service.inspect(plan.task.investigationId, h.ctx), code('READONLY_INVALID_RECORD'));
      assert.equal(h.received.length, 0);
    } finally { await h.close(); }
  }
});

test('readonly rejects unsafe private database permission and links', async () => {
  const h = await setup();
  try {
    chmodSync(h.file, 0o644);
    assert.throws(() => h.store.inspect('bad-id', h.ctx), code('UNSAFE_RUNTIME_FILE'));
    chmodSync(h.file, 0o600);
    assert.throws(() => new SqliteReadonlyInvestigationStore('relative.sqlite'), code('UNSAFE_RUNTIME_PATH'));
  } finally { await h.close(); }
});

test('readonly recovery requires both unchanged source and proven cleanup', async () => {
  for (const condition of ['unchanged', 'changed', 'expired'] as const) {
    const h = await setup();
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx);
      approve(h, plan);
      h.store.claim(request(plan), h.ctx);
      const service = new ReadonlyInvestigationService(h.store, { mode: 'mock', investigate: async () => { throw new Error('must not run'); } }, h.directory, () => true);
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
