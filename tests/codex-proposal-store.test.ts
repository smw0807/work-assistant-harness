import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteCodexProposalStore } from '../src/adapters/sqlite-codex-proposal-store.js';
import { CodexProposalService } from '../src/application/propose-codex.js';
import type { CodexProposalContext, CodexProposalTask } from '../src/domain/codex-proposal.js';
import type { CodexProposalPort } from '../src/ports/codex-proposal.js';
import { createCodexProposalPlan, getCodexProposalInput, parseCodexProposalResponse } from '../src/policy/codex-proposal-policy.js';

const configHash = 'a'.repeat(64);
const raw = JSON.stringify({ path: 'src/message.mjs', content: "export const message = 'approved';\n" });
const setup = async (context: TestContext, port: CodexProposalPort = { async propose() { return raw; } }) => {
  const directory = await fileSystem.realpath(await fileSystem.mkdtemp(join(tmpdir(), 'codex-proposal-store-')));
  const filePath = join(directory, 'codex-proposals.sqlite');
  const opened = new Set<SqliteCodexProposalStore>();
  const open = (): SqliteCodexProposalStore => {
    const result = new SqliteCodexProposalStore(filePath);
    opened.add(result);
    return result;
  };
  const close = (store: SqliteCodexProposalStore): void => { store.close(); opened.delete(store); };
  context.after(async () => {
    for (const store of opened) store.close();
    await fileSystem.chmod(directory, 0o700);
    await fileSystem.rm(directory, { recursive: true, force: true });
  });
  const store = open();
  const service = new CodexProposalService(store, port, configHash);
  const now = new Date(Date.now() + 3_600_000);
  const ownerContext: CodexProposalContext = { ownerId: `os-user:${process.getuid!()}`, now };
  const task = service.plan('fix', ownerContext);
  const request = { proposalId: task.proposalId, planHash: task.plan.planHash, expiresInMinutes: 30 };
  const later = (milliseconds: number): CodexProposalContext => ({ ownerId: ownerContext.ownerId, now: new Date(now.getTime() + milliseconds) });
  return { directory, filePath, store, service, task, request, ownerContext, later, open, close };
};

test('approval, single claim, READY result and single export survive restart without granting execution approval', async (context) => {
  let calls = 0;
  const { service, store, task, request, ownerContext, open, close } = await setup(context, {
    async propose(input) { calls += 1; assert.equal(input, getCodexProposalInput().inputText); return raw; },
  });
  assert.equal(service.inspect(task.proposalId, ownerContext).attempt, null);
  await assert.rejects(service.run(task.proposalId, task.plan.planHash, ownerContext), { code: 'CODEX_PROPOSAL_APPROVAL_REQUIRED' });
  assert.equal(calls, 0);
  const approval = service.approve(request, ownerContext);
  approval.planSnapshot.workType = 'chore';
  assert.equal(service.inspect(task.proposalId, ownerContext).approvals[0]!.planSnapshot.workType, 'fix');
  const ready = await service.run(task.proposalId, task.plan.planHash, ownerContext);
  assert.equal(calls, 1);
  assert.equal(ready.task.status, 'READY');
  assert.equal(ready.attempt!.status, 'READY');
  assert.equal(ready.approvals[0]!.usedAt, ownerContext.now.toISOString());
  assert.deepEqual(ready.task.result, parseCodexProposalResponse(raw));
  close(store);
  const restarted = open();
  const exported = restarted.consumeForExecution(task.proposalId, ownerContext);
  assert.deepEqual(exported, { proposalId: task.proposalId, workType: 'fix', inputHash: task.plan.inputHash, configHash, ...parseCodexProposalResponse(raw) });
  assert.equal(restarted.inspect(task.proposalId, ownerContext).task.status, 'EXPORTED');
  assert.throws(() => restarted.consumeForExecution(task.proposalId, ownerContext), { code: 'CODEX_PROPOSAL_NOT_READY' });
  assert.throws(() => restarted.approve(request, ownerContext), { code: 'CODEX_PROPOSAL_NOT_READY' });
  assert.throws(() => restarted.claim(task.proposalId, task.plan.planHash, ownerContext), { code: 'CODEX_PROPOSAL_APPROVAL_REQUIRED' });
});

test('TTL is required, integer bounded and expiry revocation commits even when claim is denied', async (context) => {
  const { store, task, request, ownerContext, later } = await setup(context);
  for (const expiresInMinutes of [undefined, 0, 61, 1.5, '30', NaN]) {
    assert.throws(() => store.approve({ ...request, expiresInMinutes } as typeof request, ownerContext), { code: 'CODEX_PROPOSAL_INVALID_APPROVAL' });
  }
  store.approve({ ...request, expiresInMinutes: 1 }, ownerContext);
  assert.throws(() => store.claim(task.proposalId, task.plan.planHash, later(60_000)), { code: 'CODEX_PROPOSAL_APPROVAL_REQUIRED' });
  const expired = store.inspect(task.proposalId, later(60_000));
  assert.equal(expired.task.status, 'AWAITING_APPROVAL');
  assert.equal(expired.approvals[0]!.revokedAt, later(60_000).now.toISOString());
  store.approve(request, later(60_001));
  const page = store.inspect(task.proposalId, later(60_001));
  assert.deepEqual(page.approvalPage, { offset: 0, total: 2, nextOffset: 1 });
  assert.equal(store.inspect(task.proposalId, later(60_001), 1).approvals[0]!.revokedAt, later(60_000).now.toISOString());
  assert.throws(() => store.approve(request, later(86_400_000)), { code: 'CODEX_PROPOSAL_NOT_READY' });
  assert.equal(store.inspect(task.proposalId, later(86_400_000)).task.failureCode, 'CODEX_PROPOSAL_PLAN_EXPIRED');
});

test('owner, time, exact hash and config mismatches prevent calls and result export', async (context) => {
  let calls = 0;
  const { store, service, task, request, ownerContext, later } = await setup(context, { async propose() { calls += 1; return raw; } });
  assert.throws(() => store.approve(request, { ...ownerContext, ownerId: `os-user:${process.getuid!() + 1}` }), { code: 'CODEX_PROPOSAL_OWNER_MISMATCH' });
  assert.throws(() => store.approve({ ...request, planHash: 'b'.repeat(64) }, ownerContext), { code: 'CODEX_PROPOSAL_PLAN_HASH_MISMATCH' });
  assert.throws(() => store.inspect(task.proposalId, { ...ownerContext, now: new Date(NaN) }), { code: 'CODEX_PROPOSAL_INVALID_TIME' });
  service.approve(request, later(1));
  assert.throws(() => store.create(task.plan, ownerContext), { code: 'CODEX_PROPOSAL_INVALID_TIME' });
  const changed = new CodexProposalService(store, { async propose() { calls += 1; return raw; } }, 'b'.repeat(64));
  assert.throws(() => changed.approve(request, later(1)), { code: 'CODEX_PROPOSAL_CONFIG_MISMATCH' });
  await assert.rejects(changed.run(task.proposalId, task.plan.planHash, later(1)), { code: 'CODEX_PROPOSAL_CONFIG_MISMATCH' });
  assert.equal(calls, 0);
  await service.run(task.proposalId, task.plan.planHash, later(1));
  assert.throws(() => changed.consumeForExecution(task.proposalId, later(1)), { code: 'CODEX_PROPOSAL_CONFIG_MISMATCH' });
  assert.throws(() => service.consumeForExecution(task.proposalId, later(86_400_000)), { code: 'CODEX_PROPOSAL_PLAN_EXPIRED' });
  assert.equal(store.inspect(task.proposalId, later(86_400_000)).task.exportedAt, null);
});

test('two connections cannot claim or export twice and failed storage rolls back approval consumption', async (context) => {
  const { store, task, request, ownerContext, open, filePath } = await setup(context);
  store.approve(request, ownerContext);
  const external = new DatabaseSync(filePath);
  external.exec("CREATE TRIGGER deny_proposal_attempt BEFORE INSERT ON codex_proposal_attempts BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END;");
  assert.throws(() => store.claim(task.proposalId, task.plan.planHash, ownerContext));
  assert.equal(store.inspect(task.proposalId, ownerContext).approvals[0]!.usedAt, null);
  assert.equal(store.inspect(task.proposalId, ownerContext).task.status, 'APPROVED');
  external.exec('DROP TRIGGER deny_proposal_attempt');
  external.close();
  const competing = open();
  const attempt = store.claim(task.proposalId, task.plan.planHash, ownerContext);
  assert.throws(() => competing.claim(task.proposalId, task.plan.planHash, ownerContext), { code: 'CODEX_PROPOSAL_APPROVAL_REQUIRED' });
  store.finish(task.proposalId, attempt.generation, parseCodexProposalResponse(raw), null, ownerContext);
  competing.consumeForExecution(task.proposalId, ownerContext);
  assert.throws(() => store.consumeForExecution(task.proposalId, ownerContext), { code: 'CODEX_PROPOSAL_NOT_READY' });
});

test('RUNNING restart is retained until explicit recovery and can never call or export again', async (context) => {
  const { store, task, request, ownerContext, later, open, close } = await setup(context);
  store.approve(request, ownerContext);
  const attempt = store.claim(task.proposalId, task.plan.planHash, ownerContext);
  close(store);
  const restarted = open();
  assert.equal(restarted.inspect(task.proposalId, later(1)).task.status, 'RUNNING');
  const recovered = restarted.recover(task.proposalId, later(2));
  assert.equal(recovered.task.status, 'INTERRUPTED');
  assert.equal(recovered.approvals[0]!.usedAt, attempt.startedAt);
  assert.deepEqual(restarted.recover(task.proposalId, later(3)), recovered);
  const late = restarted.finish(task.proposalId, attempt.generation, parseCodexProposalResponse(raw), null, later(4));
  assert.equal(late.task.result, null);
  assert.equal(late.task.status, 'INTERRUPTED');
  assert.throws(() => restarted.approve(request, later(4)));
  assert.throws(() => restarted.claim(task.proposalId, task.plan.planHash, later(4)));
  assert.throws(() => restarted.consumeForExecution(task.proposalId, later(4)));
});

test('cancellation fences late responses and waits for adapter cleanup before returning', async (context) => {
  let release: (value: string) => void = () => undefined;
  let began: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let adapterSignal: AbortSignal | undefined;
  const { store, service, task, request, ownerContext, later } = await setup(context, {
    async propose(_input, signal) { adapterSignal = signal; began(); return new Promise<string>((resolve) => { release = resolve; }); },
  });
  service.approve(request, ownerContext);
  let returned = false;
  const running = service.run(task.proposalId, task.plan.planHash, ownerContext).then((value) => { returned = true; return value; });
  await started;
  store.cancel(task.proposalId, ownerContext);
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(adapterSignal!.aborted, true);
  assert.equal(returned, false);
  release(raw);
  const cancelled = await running;
  assert.equal(cancelled.task.status, 'CANCELLED');
  assert.equal(cancelled.task.result, null);
  assert.equal(cancelled.attempt!.status, 'CANCELLED');
  assert.equal(cancelled.approvals[0]!.usedAt, ownerContext.now.toISOString());
  assert.deepEqual(store.cancel(task.proposalId, later(1)), cancelled);
  assert.throws(() => store.consumeForExecution(task.proposalId, later(1)));
});

test('cancelling before a call or after READY prevents consumption without restoring an approval', async (context) => {
  for (const stage of ['pending', 'approved', 'ready'] as const) {
    let calls = 0;
    const { service, store, task, request, ownerContext } = await setup(context, { async propose() { calls += 1; return raw; } });
    if (stage !== 'pending') service.approve(request, ownerContext);
    if (stage === 'ready') await service.run(task.proposalId, task.plan.planHash, ownerContext);
    const cancelled = service.cancel(task.proposalId, ownerContext);
    assert.equal(cancelled.task.status, 'CANCELLED');
    assert.equal(calls, stage === 'ready' ? 1 : 0);
    assert.throws(() => store.consumeForExecution(task.proposalId, ownerContext));
    if (stage === 'approved') assert.equal(cancelled.approvals[0]!.revokedAt, ownerContext.now.toISOString());
  }
});

test('invalid responses and adapter exceptions persist static failure only and cannot be retried', async (context) => {
  const privateBody = 'SYNTHETIC_PRIVATE_RESPONSE_BODY';
  for (const mode of ['json', 'content', 'size', 'throw'] as const) {
    const { service, store, task, request, ownerContext, filePath } = await setup(context, {
      async propose() {
        if (mode === 'throw') throw new Error(privateBody);
        if (mode === 'size') return privateBody.repeat(1024);
        if (mode === 'content') return JSON.stringify({ path: '.env', content: privateBody });
        return privateBody;
      },
    });
    service.approve(request, ownerContext);
    const failed = await service.run(task.proposalId, task.plan.planHash, ownerContext);
    assert.equal(failed.task.status, 'FAILED');
    assert.equal(failed.task.result, null);
    assert.equal(failed.attempt!.responseHash, null);
    assert.doesNotMatch(JSON.stringify(failed), /SYNTHETIC_PRIVATE_RESPONSE_BODY/);
    assert.equal(fs.readFileSync(filePath).includes(Buffer.from(privateBody)), false);
    assert.throws(() => store.approve(request, ownerContext));
    await assert.rejects(service.run(task.proposalId, task.plan.planHash, ownerContext));
  }
});

test('column, immutable approval, attempt relation and result payload tampering are rejected', async (context) => {
  for (const mutation of ['column', 'plan', 'approval', 'attempt', 'result'] as const) {
    const { store, service, task, request, ownerContext, filePath } = await setup(context);
    service.approve(request, ownerContext);
    if (['attempt', 'result'].includes(mutation)) await service.run(task.proposalId, task.plan.planHash, ownerContext);
    const database = new DatabaseSync(filePath);
    try {
      if (mutation === 'column') database.prepare('UPDATE codex_proposal_tasks SET status = ?').run('RUNNING');
      else if (mutation === 'approval') {
        const row = database.prepare('SELECT payload FROM codex_proposal_approvals').get()!;
        const approval = JSON.parse(String(row.payload)) as { ownerId: string };
        approval.ownerId = 'os-user:987654321';
        database.prepare('UPDATE codex_proposal_approvals SET payload = ?').run(JSON.stringify(approval));
      } else if (mutation === 'attempt') {
        const row = database.prepare('SELECT payload FROM codex_proposal_attempts').get()!;
        const attempt = JSON.parse(String(row.payload)) as { responseHash: string };
        attempt.responseHash = 'b'.repeat(64);
        database.prepare('UPDATE codex_proposal_attempts SET payload = ?').run(JSON.stringify(attempt));
      } else {
        const row = database.prepare('SELECT payload FROM codex_proposal_tasks').get()!;
        const payload = JSON.parse(String(row.payload)) as CodexProposalTask;
        if (mutation === 'plan') payload.plan.workType = 'chore';
        else payload.result!.content = 'unapproved change';
        database.prepare('UPDATE codex_proposal_tasks SET payload = ?').run(JSON.stringify(payload));
      }
      assert.throws(() => store.inspect(task.proposalId, ownerContext));
    } finally { database.close(); }
  }
});

test('private SQLite paths reject links, sidecars, traversal and unsafe modes', async (context) => {
  for (const mutation of ['symlink', 'hardlink', 'sidecar-link', 'file-mode', 'directory-mode', 'traversal'] as const) {
    const { store, close, filePath, directory } = await setup(context);
    close(store);
    let target = filePath;
    if (mutation === 'symlink' || mutation === 'hardlink') {
      const retained = `${filePath}.retained`;
      await fileSystem.rename(filePath, retained);
      if (mutation === 'symlink') await fileSystem.symlink(retained, filePath);
      else await fileSystem.link(retained, filePath);
    } else if (mutation === 'sidecar-link') await fileSystem.symlink(filePath, `${filePath}-journal`);
    else if (mutation === 'file-mode') await fileSystem.chmod(filePath, 0o644);
    else if (mutation === 'directory-mode') await fileSystem.chmod(directory, 0o755);
    else target = `${directory}/../${directory.split('/').at(-1)}/codex-proposals.sqlite`;
    assert.throws(() => new SqliteCodexProposalStore(target));
  }
});

test('plan lifetime and approval lifetime are independent and successful results cannot export after plan expiry', async (context) => {
  const { store, service, ownerContext, later } = await setup(context);
  const plan = createCodexProposalPlan('feature', configHash, ownerContext);
  const task = store.create(plan, later(86_370_000));
  const approval = store.approve({ proposalId: task.proposalId, planHash: task.plan.planHash, expiresInMinutes: 60 }, later(86_370_000));
  assert.equal(approval.expiresAt, plan.expiresAt);
  await service.run(task.proposalId, task.plan.planHash, later(86_370_001));
  assert.throws(() => store.consumeForExecution(task.proposalId, later(86_400_000)), { code: 'CODEX_PROPOSAL_PLAN_EXPIRED' });
});

test('failed export commit leaves READY and committed export stays consumed through cancellation and recovery', async (context) => {
  const { store, service, task, request, ownerContext, later, filePath } = await setup(context);
  service.approve(request, ownerContext);
  await service.run(task.proposalId, task.plan.planHash, ownerContext);
  const database = new DatabaseSync(filePath);
  try {
    database.exec("CREATE TRIGGER deny_proposal_export BEFORE UPDATE ON codex_proposal_tasks WHEN NEW.status = 'EXPORTED' BEGIN SELECT RAISE(ABORT, 'synthetic export failure'); END;");
    assert.throws(() => store.consumeForExecution(task.proposalId, ownerContext));
    assert.equal(store.inspect(task.proposalId, ownerContext).task.status, 'READY');
    assert.equal(store.inspect(task.proposalId, ownerContext).task.exportedAt, null);
    database.exec('DROP TRIGGER deny_proposal_export');
  } finally { database.close(); }
  store.consumeForExecution(task.proposalId, later(1));
  const consumed = store.inspect(task.proposalId, later(1));
  assert.deepEqual(store.cancel(task.proposalId, later(2)), consumed);
  assert.deepEqual(store.recover(task.proposalId, later(3)), consumed);
  assert.throws(() => store.consumeForExecution(task.proposalId, later(3)), { code: 'CODEX_PROPOSAL_NOT_READY' });
});

test('run checks the actual current clock before calling a port even if the supplied context is stale', async (context) => {
  const { store, directory } = await setup(context);
  let calls = 0;
  const service = new CodexProposalService(store, { async propose() { calls += 1; return raw; } }, configHash);
  const stale = { ownerId: `os-user:${process.getuid!()}`, now: new Date(Date.now() - 2 * 86_400_000) };
  const task = service.plan('fix', stale);
  service.approve({ proposalId: task.proposalId, planHash: task.plan.planHash, expiresInMinutes: 60 }, stale);
  await assert.rejects(service.run(task.proposalId, task.plan.planHash, stale), { code: 'CODEX_PROPOSAL_APPROVAL_REQUIRED' });
  assert.equal(calls, 0);
  assert.equal(store.inspect(task.proposalId, { ...stale, now: new Date() }).task.failureCode, 'CODEX_PROPOSAL_PLAN_EXPIRED');
  assert.deepEqual((await fileSystem.readdir(directory)).filter((name) => !name.startsWith('codex-proposals.sqlite')), []);
});
