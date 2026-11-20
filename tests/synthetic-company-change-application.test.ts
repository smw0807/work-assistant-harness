import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import type { SyntheticCompanyChangeStore, SyntheticCompanyChangeWorkspacePort } from '../src/ports/synthetic-company-change.js';
import { SyntheticCompanyChangeService } from '../src/application/apply-synthetic-company-change.js';
import { SqliteSyntheticCompanyChangeStore } from '../src/adapters/sqlite-synthetic-company-change-store.js';
import { createSyntheticCompanyChangeWorkspace, SYNTHETIC_COMPANY_CHANGE_FILES } from '../src/adapters/synthetic-company-change-workspace.js';
import { hashCompanyChangeValue } from '../src/policy/company-change.js';

const fixture = async () => {
  const root = await mkdtemp('/private/tmp/harness-synthetic-change-service-');
  await mkdir(join(root, 'store'), { mode: 0o700 });
  const workspace = await createSyntheticCompanyChangeWorkspace(root);
  const storePath = join(root, 'store', 'synthetic-company-change.sqlite');
  const store = new SqliteSyntheticCompanyChangeStore(storePath);
  const clock = { now: new Date('2026-11-20T00:00:00.000Z') };
  const service = new SyntheticCompanyChangeService(store, workspace, () => clock.now);
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: 'synthetic-company-change',
    requestRevision: 1, objective: 'Apply three synthetic changes', baseCommit: workspace.baseCommit,
    baseBranch: 'main', baseIndexHash: workspace.baseIndexHash, workType: 'feature', branch: 'feature/synthetic-multiple',
    changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!), content: "export const message = 'approved';\n" },
      { operation: 'replace', path: 'src/options.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!), content: 'export const enabled = true;\n' },
      { operation: 'create', path: 'src/new.ts', beforeHash: null, content: 'export const added = 3;\n' },
    ] };
  return { root, workspace, store, storePath, clock, service, draft,
    async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
};

const overrideWorkspace = (workspace: SyntheticCompanyChangeWorkspacePort,
  overrides: Partial<SyntheticCompanyChangeWorkspacePort>): SyntheticCompanyChangeWorkspacePort => ({
  acquire: workspace.acquire.bind(workspace), observe: workspace.observe.bind(workspace),
  createBranch: workspace.createBranch.bind(workspace), writeFile: workspace.writeFile.bind(workspace),
  verifyApplied: workspace.verifyApplied.bind(workspace), ...overrides,
});

const overrideStore = (store: SyntheticCompanyChangeStore,
  overrides: Partial<SyntheticCompanyChangeStore>): SyntheticCompanyChangeStore => ({
  create: store.create.bind(store), inspect: store.inspect.bind(store), approve: store.approve.bind(store),
  claim: store.claim.bind(store), record: store.record.bind(store), finish: store.finish.bind(store),
  cancel: store.cancel.bind(store), close: store.close.bind(store), ...overrides,
});

const approve = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const prepared = await f.service.prepare(f.draft);
  const request = { taskId: prepared.plan.id, planHash: prepared.plan.planHash };
  await f.service.approve({ ...request, expiresInMinutes: 10 }, f.draft);
  return request;
};

test('synthetic apply changes three files only after switching the original repository to a new branch', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace.repositoryRoot, 'README.md'), 'User work preserved\n');
    const index = await readFile(join(f.workspace.repositoryRoot, '.git/index'));
    const main = await readFile(join(f.workspace.repositoryRoot, '.git/refs/heads/main'));
    const before = await readFile(join(f.workspace.repositoryRoot, 'src/message.ts'));
    const prepared = await f.service.prepare(f.draft);
    const request = { taskId: prepared.plan.id, planHash: prepared.plan.planHash };
    await assert.rejects(f.service.apply(request, f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    assert.deepEqual(await readFile(join(f.workspace.repositoryRoot, 'src/message.ts')), before);
    await f.service.approve({ ...request, expiresInMinutes: 10 }, f.draft);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    const service = new SyntheticCompanyChangeService(f.store, overrideWorkspace(f.workspace, {
      async writeFile(plan, draft, index) {
        assert.equal(await readFile(join(f.workspace.repositoryRoot, '.git/HEAD'), 'utf8'), `ref: refs/heads/${draft.branch}\n`);
        await f.workspace.writeFile(plan, draft, index);
      },
    }), () => f.clock.now);
    const result = await service.apply(request, f.draft);
    assert.equal(result.status, 'APPLIED'); assert.equal(result.plan.checks, 'not_run');
    assert.equal(result.plan.transmissionAllowed, false); assert.equal(result.journal.length, 8);
    assert.ok(result.approval?.usedAt); assert.equal(result.failureCode, null);
    for (const change of f.draft.changes) assert.equal(await readFile(join(f.workspace.repositoryRoot, change.path), 'utf8'), change.content);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, 'README.md'), 'utf8'), 'User work preserved\n');
    assert.deepEqual(await readFile(join(f.workspace.repositoryRoot, '.git/index')), index);
    assert.deepEqual(await readFile(join(f.workspace.repositoryRoot, '.git/refs/heads/main')), main);
    await assert.rejects(service.apply(request, f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
  } finally { await f.close(); }
});

test('approval checks source freshness and applying checks it again without consuming a stale approval', async () => {
  const f = await fixture();
  try {
    const request = await approve(f);
    await writeFile(join(f.workspace.repositoryRoot, 'README.md'), 'Changed after approval\n');
    await assert.rejects(f.service.apply(request, f.draft));
    const snapshot = f.service.inspect(request.taskId);
    assert.equal(snapshot.status, 'APPROVED'); assert.equal(snapshot.approval?.usedAt, null);
    assert.equal(snapshot.journal.length, 0);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    await assert.rejects(f.service.approve({ ...request, expiresInMinutes: 10 }, f.draft));
  } finally { await f.close(); }
});

test('changed replacement bytes and a review-only approval cannot authorize writes', async () => {
  const f = await fixture();
  try {
    const request = await approve(f), altered = structuredClone(f.draft);
    altered.changes[0]!.content = 'Unexpected replacement\n';
    await assert.rejects(f.service.apply(request, altered));
    await assert.rejects(f.service.apply({ ...request, scope: 'review-only' } as typeof request, f.draft));
    assert.equal(f.service.inspect(request.taskId).approval?.usedAt, null);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  } finally { await f.close(); }
});

test('a failed second write preserves the first write, used approval and ordered partial journal', async () => {
  const f = await fixture();
  try {
    const request = await approve(f);
    const service = new SyntheticCompanyChangeService(f.store, overrideWorkspace(f.workspace, {
      async writeFile(plan, draft, index) {
        if (index === 1) throw new Error('synthetic injected write failure');
        await f.workspace.writeFile(plan, draft, index);
      },
    }), () => f.clock.now);
    const result = await service.apply(request, f.draft);
    assert.equal(result.status, 'FAILED'); assert.ok(result.approval?.usedAt);
    assert.deepEqual(result.journal.map(entry => [entry.kind, entry.path, entry.state]), [
      ['branch', null, 'INTENT'], ['branch', null, 'DONE'],
      ['file', 'src/message.ts', 'INTENT'], ['file', 'src/message.ts', 'DONE'], ['file', 'src/options.ts', 'INTENT'],
    ]);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, 'src/message.ts'), 'utf8'), f.draft.changes[0]!.content);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, 'src/options.ts'), 'utf8'), SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']);
    await assert.rejects(readFile(join(f.workspace.repositoryRoot, 'src/new.ts')), { code: 'ENOENT' });
    await assert.rejects(service.apply(request, f.draft));
  } finally { await f.close(); }
});

test('failed durable intent prevents the corresponding branch mutation', async () => {
  const f = await fixture();
  try {
    const request = await approve(f);
    const service = new SyntheticCompanyChangeService(overrideStore(f.store, {
      record() { throw new Error('synthetic journal failure'); },
    }), f.workspace, () => f.clock.now);
    const result = await service.apply(request, f.draft);
    assert.equal(result.status, 'FAILED'); assert.equal(result.journal.length, 0);
    assert.ok(result.approval?.usedAt);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  } finally { await f.close(); }
});

test('unrecordable failure remains APPLYING after reopening and cannot be retried', async () => {
  const f = await fixture();
  try {
    const request = await approve(f);
    const service = new SyntheticCompanyChangeService(overrideStore(f.store, {
      finish() { throw new Error('synthetic store unavailable'); },
    }), overrideWorkspace(f.workspace, {
      async writeFile() { throw new Error('synthetic write failure'); },
    }), () => f.clock.now);
    await assert.rejects(service.apply(request, f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_OUTCOME_UNKNOWN' });
    f.store.close();
    const reopened = new SqliteSyntheticCompanyChangeStore(f.storePath);
    try {
      const restarted = new SyntheticCompanyChangeService(reopened, f.workspace, () => f.clock.now);
      assert.equal(restarted.inspect(request.taskId).status, 'APPLYING');
      await assert.rejects(restarted.apply(request, f.draft));
      assert.equal(restarted.inspect(request.taskId).journal.length, 3);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('expiration during source verification is checked again before consumption', async () => {
  const f = await fixture();
  try {
    const request = await approve(f);
    const service = new SyntheticCompanyChangeService(f.store, overrideWorkspace(f.workspace, {
      async observe(draft) {
        const source = await f.workspace.observe(draft);
        f.clock.now = new Date(f.clock.now.getTime() + 10 * 60_000);
        return source;
      },
    }), () => f.clock.now);
    await assert.rejects(service.apply(request, f.draft));
    assert.equal(service.inspect(request.taskId).status, 'EXPIRED');
    assert.equal(service.inspect(request.taskId).approval?.usedAt, null);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  } finally { await f.close(); }
});

test('expiry after a file write stops further writes while retaining the consumed approval', async () => {
  const f = await fixture();
  try {
    const request = await approve(f);
    const service = new SyntheticCompanyChangeService(f.store, overrideWorkspace(f.workspace, {
      async writeFile(plan, draft, index) {
        await f.workspace.writeFile(plan, draft, index);
        f.clock.now = new Date(f.clock.now.getTime() + 10 * 60_000);
      },
    }), () => f.clock.now);
    const result = await service.apply(request, f.draft);
    assert.equal(result.status, 'FAILED'); assert.equal(result.journal.length, 4);
    assert.ok(result.approval?.usedAt);
    assert.equal(await readFile(join(f.workspace.repositoryRoot, 'src/options.ts'), 'utf8'), SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']);
  } finally { await f.close(); }
});

test('cancellation and concurrent apply attempts do not reuse an execution approval', async () => {
  const f = await fixture();
  try {
    const cancelled = await approve(f);
    assert.equal(f.service.cancel(cancelled.taskId).status, 'CANCELLED');
    await assert.rejects(f.service.apply(cancelled, f.draft));
    const request = await approve(f);
    const results = await Promise.allSettled([f.service.apply(request, f.draft), f.service.apply(request, f.draft)]);
    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.status === 'APPLIED').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.service.inspect(request.taskId).journal.length, 8);
  } finally { await f.close(); }
});
