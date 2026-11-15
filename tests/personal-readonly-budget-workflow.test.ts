import assert from 'node:assert/strict';
import fs, { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import git from 'isomorphic-git';
import { SqlitePersonalReadonlyStore } from '../src/adapters/sqlite-personal-readonly-store.js';
import { PersonalReadonlyService } from '../src/application/investigate-personal-readonly.js';
import type { PersonalBudgetRegistration } from '../src/domain/personal-readonly-budget.js';
import type { PersonalCollectionRegistration } from '../src/domain/personal-readonly-collection.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../src/ports/readonly-relay.js';
import type { PersonalReadonlySnapshot } from '../src/ports/personal-readonly.js';
import { derivePersonalSourceView } from '../src/policy/personal-readonly-collection.js';
import { buildReadonlyMockResponse, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { validateAnyPersonalPayload } from '../src/policy/personal-readonly-contract.js';

const oldConfig: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v2', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const config: ReadonlyRelayConfig = { ...oldConfig, policyVersion: 'readonly-relay-codex-v3', timeoutMs: 125000 };
const originalClient = 'const accessToken = "SYNTHETIC_BUDGET_SECRET_A_123456";\nexport const connect = () => "public";\n';
const changedClient = originalClient.replace('SECRET_A', 'SECRET_B');
const request = (snapshot: PersonalReadonlySnapshot) => ({ investigationId: snapshot.task.investigationId, planHash: snapshot.task.plan.planHash });
const respond = (dispatch: ReadonlyRelayDispatch): ReadonlyRelayTransmissionResult => {
  const body = JSON.parse(dispatch.requestEnvelope.body) as { input: { content: { text: string }[] }[] };
  const text = buildReadonlyMockResponse(body.input[0]!.content[0]!.text);
  return { text, responseHash: hashReadonlyValue('synthetic budget SSE'), finalTextHash: hashReadonlyValue(text),
    verification: { transport: 'fake', upstreamCalls: 1, isolation: 'not_run', credentialAccess: 'not_run',
      responseValidation: 'codex-native-output-v1', relayCompleted: true, credentialReflection: 'passed' } };
};
const setup = async (selectedPort?: ReadonlyRelayPort) => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'personal-budget-workflow-'))); chmodSync(directory, 0o700);
  const sourceRoot = join(directory, 'source'), runtime = join(directory, 'runtime');
  await mkdir(join(sourceRoot, 'src'), { recursive: true, mode: 0o700 }); await mkdir(runtime, { mode: 0o700 });
  const files = { 'src/client.ts': originalClient, 'src/large.ts': `// ${'x'.repeat(40 * 1024)}\nexport const start = () => "bounded";\n` };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(sourceRoot, path), content);
  await git.init({ fs, dir: sourceRoot, defaultBranch: 'main' });
  for (const path of Object.keys(files)) await git.add({ fs, dir: sourceRoot, filepath: path });
  const baseCommit = await git.commit({ fs, dir: sourceRoot, message: 'synthetic budget fixture',
    author: { name: 'Synthetic', email: 'synthetic@example.test', timestamp: 1_700_000_000, timezoneOffset: 0 } });
  const collection: PersonalCollectionRegistration = { version: 'personal-readonly-registration-v2', collectionPolicy: 'personal-readonly-collection-v2',
    repoId: 'personal-test', sourceRoot, baseCommit, question: 'Explain only visible supplied calls.',
    readRanges: [{ path: 'src/client.ts', startLine: 2, endLine: 2 }, { path: 'src/large.ts', startLine: 2, endLine: 2 }],
    transferPaths: ['src/client.ts', 'src/large.ts'] };
  const budget: PersonalBudgetRegistration = { ...collection, version: 'personal-readonly-registration-v3', executionBudgetPolicy: 'readonly-relay-execution-budget-v1' };
  const file = join(runtime, 'personal-readonly.sqlite'); let store = new SqlitePersonalReadonlyStore(file); let calls = 0;
  const port: ReadonlyRelayPort = selectedPort ?? { mode: 'live', transport: 'codex-cli-relay', transmit: async (input, _signal, before, beforeCredential) => {
    beforeCredential(); before(); calls++; return respond(input);
  } };
  const makeService = (configuration: ReadonlyRelayConfig) => new PersonalReadonlyService(store, port, runtime, configuration, () => true);
  let service = makeService(config), previous = makeService(oldConfig);
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date(Date.now() + 10000) };
  return { sourceRoot, runtime, file, context, collection, budget, calls: () => calls, get store() { return store; },
    get service() { return service; }, get previous() { return previous; },
    reopen: () => { store.close(); store = new SqlitePersonalReadonlyStore(file); service = makeService(config); previous = makeService(oldConfig); },
    close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
};

test('old collection-v2 and budget-v3 coexist across restart with separate configs, approvals and exact report shapes', async () => {
  const h = await setup();
  try {
    const old = await h.previous.plan(h.collection, h.context); const next = await h.service.plan(h.budget, h.context);
    assert.notEqual(old.task.plan.planHash, next.task.plan.planHash); assert.notEqual(old.task.plan.configHash, next.task.plan.configHash);
    assert.notEqual(old.task.plan.connectionProfileHash, next.task.plan.connectionProfileHash);
    assert.equal(old.task.plan.limits.responseTimeoutMs, 55000); assert.equal(old.task.plan.limits.frames, 2048);
    assert.equal(next.task.plan.limits.responseTimeoutMs, 120000); assert.equal(next.task.plan.limits.frames, 8192);
    assert.throws(() => validateAnyPersonalPayload(old.task.plan, next.payload!));
    assert.throws(() => h.service.approve({ ...request(old), expiresInMinutes: 10 }, h.context));
    assert.throws(() => h.previous.approve({ ...request(next), expiresInMinutes: 10 }, h.context));
    h.previous.approve({ ...request(old), expiresInMinutes: 10 }, h.context); h.service.approve({ ...request(next), expiresInMinutes: 10 }, h.context);
    h.reopen(); const first = await h.previous.run(request(old), h.context); const second = await h.service.run(request(next), h.context);
    assert.equal(first.task.status, 'REPORTED'); assert.equal(second.task.status, 'REPORTED'); assert.equal(h.calls(), 2);
    assert.equal('executionBudget' in first.report!, false); assert.ok('executionBudget' in second.report!);
    assert.ok('executionBudget' in next.task.plan);
    assert.deepEqual(second.report.executionBudget, { policy: 'readonly-relay-execution-budget-v1',
      profileHash: next.task.plan.executionBudgetHash, workTimeoutMs: 120000, frames: 8192 });
    assert.ok('collection' in second.report!); assert.deepEqual(second.report.collection, {
      policy: 'personal-readonly-collection-v2', profileHash: next.task.plan.collectionProfileHash,
      sourceViewsHash: next.task.plan.sourceViewsHash, evidenceOrigin: 'line-preserving-derived-view' });
    h.reopen(); assert.deepEqual(h.service.inspect(next.task.investigationId, h.context).report, second.report);
    await assert.rejects(h.service.run(request(next), h.context), { code: 'PERSONAL_READONLY_APPROVAL_REQUIRED' }); assert.equal(h.calls(), 2);
  } finally { await h.close(); }
});

test('mixed registration/config is rejected before filesystem inspection or a task write, and unapproved run precedes readiness', async () => {
  let readiness = 0; const h = await setup({ mode: 'live', transport: 'codex-cli-relay', verifyReady: async () => { readiness++; }, transmit: async () => { throw new Error('not called'); } });
  try {
    await assert.rejects(h.service.plan({ ...h.collection, sourceRoot: '/missing-synthetic-source' }, h.context), { code: 'PERSONAL_READONLY_INVALID_CONFIG' });
    await assert.rejects(h.previous.plan({ ...h.budget, sourceRoot: '/missing-synthetic-source' }, h.context), { code: 'PERSONAL_READONLY_INVALID_CONFIG' });
    const db = new DatabaseSync(h.file); assert.equal(db.prepare('select count(*) as count from personal_readonly_tasks').get()!.count, 0); db.close();
    const plan = await h.service.plan(h.budget, h.context);
    await assert.rejects(h.service.run(request(plan), h.context), { code: 'PERSONAL_READONLY_APPROVAL_REQUIRED' }); assert.equal(readiness, 0);
  } finally { await h.close(); }
});

for (const stage of ['credentials', 'network'] as const) {
  test(`budget-v3 raw-source change with the same safe view is blocked at ${stage}`, async () => {
    assert.equal(derivePersonalSourceView('src/client.ts', Buffer.from(originalClient)).viewHash,
      derivePersonalSourceView('src/client.ts', Buffer.from(changedClient)).viewHash);
    let root = '', credentials = 0, network = 0;
    const h = await setup({ mode: 'live', transport: 'codex-cli-relay', transmit: async (input, _signal, before, beforeCredential) => {
      if (stage === 'credentials') writeFileSync(join(root, 'src/client.ts'), changedClient);
      beforeCredential(); credentials++;
      if (stage === 'network') writeFileSync(join(root, 'src/client.ts'), changedClient);
      before(); network++; return respond(input);
    } });
    try {
      root = h.sourceRoot; const plan = await h.service.plan(h.budget, h.context); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.context);
      const done = await h.service.run(request(plan), h.context);
      assert.equal(done.task.status, 'BLOCKED'); assert.equal(done.task.failureCode, 'PERSONAL_READONLY_SOURCE_CHANGED'); assert.equal(done.report, null);
      assert.equal(credentials, stage === 'credentials' ? 0 : 1); assert.equal(network, 0); assert.ok(done.approvals[0]!.usedAt);
    } finally { await h.close(); }
  });
}

test('budget report metadata is mandatory, exact and cannot be attached to a legacy collection report', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan(h.budget, h.context); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.context);
    const done = await h.service.run(request(plan), h.context); assert.equal(done.task.status, 'REPORTED');
    const db = new DatabaseSync(h.file); const original = JSON.parse(String(db.prepare('select payload from personal_readonly_payloads where investigation_id=?').get(plan.task.investigationId)!.payload));
    for (const field of ['missing', 'extra', 'hash', 'work', 'frames'] as const) {
      const record = structuredClone(original);
      if (field === 'missing') delete record.report.executionBudget;
      if (field === 'extra') record.report.executionBudget.retry = 1;
      if (field === 'hash') record.report.executionBudget.profileHash = '0'.repeat(64);
      if (field === 'work') record.report.executionBudget.workTimeoutMs = 55000;
      if (field === 'frames') record.report.executionBudget.frames = 2048;
      const raw = JSON.stringify(record); db.prepare('update personal_readonly_payloads set payload=?,payload_hash=? where investigation_id=?').run(raw, hashReadonlyValue(raw), plan.task.investigationId);
      assert.throws(() => h.service.inspect(plan.task.investigationId, h.context), { code: 'PERSONAL_READONLY_INVALID_RECORD' });
    }
    const old = await h.previous.plan(h.collection, h.context); h.previous.approve({ ...request(old), expiresInMinutes: 10 }, h.context);
    const legacy = await h.previous.run(request(old), h.context); assert.equal(legacy.task.status, 'REPORTED');
    const record = JSON.parse(String(db.prepare('select payload from personal_readonly_payloads where investigation_id=?').get(old.task.investigationId)!.payload));
    record.report.executionBudget = original.report.executionBudget; const raw = JSON.stringify(record);
    db.prepare('update personal_readonly_payloads set payload=?,payload_hash=? where investigation_id=?').run(raw, hashReadonlyValue(raw), old.task.investigationId);
    assert.throws(() => h.previous.inspect(old.task.investigationId, h.context), { code: 'PERSONAL_READONLY_INVALID_RECORD' }); db.close();
  } finally { await h.close(); }
});

test('restart recovery and pruning preserve budget-v3 consumption markers and never dispatch automatically', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan(h.budget, h.context); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.context);
    const attempt = h.store.claim(request(plan), h.context); h.store.dispatch(plan.task.investigationId, attempt.generation, h.context, () => undefined);
    h.reopen(); const recovered = await h.service.recover(plan.task.investigationId, h.context);
    assert.equal(recovered.task.status, 'INTERRUPTED'); assert.ok(recovered.approvals[0]!.usedAt); assert.equal(recovered.report, null); assert.equal(h.calls(), 0);
    await assert.rejects(h.service.run(request(plan), h.context), { code: 'PERSONAL_READONLY_APPROVAL_REQUIRED' });
    const future = { ...h.context, now: new Date(Date.parse(recovered.task.terminalAt!) + 31 * 86400000) };
    assert.deepEqual(h.service.prune(future), { payloadsRemoved: 1, auditsRemoved: 1 });
    assert.throws(() => h.store.create(plan.task.plan, plan.payload!, h.context), { code: 'PERSONAL_READONLY_ID_REUSED' });
  } finally { await h.close(); }
});
