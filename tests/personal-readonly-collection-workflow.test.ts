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
import type { PersonalCollectionRegistration } from '../src/domain/personal-readonly-collection.js';
import type { PersonalReadonlyRegistration } from '../src/domain/personal-readonly.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import { derivePersonalSourceView } from '../src/policy/personal-readonly-collection.js';
import { parseAnyPersonalRegistration, validateAnyPersonalPayload } from '../src/policy/personal-readonly-contract.js';
import { buildReadonlyMockResponse, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import type { PersonalReadonlySnapshot } from '../src/ports/personal-readonly.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../src/ports/readonly-relay.js';

const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v2', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const originalClient = 'const accessToken = "SYNTHETIC_PERSONAL_SECRET_A_123456";\nexport const connect = () => "public";\n';
const changedClient = originalClient.replace('SECRET_A', 'SECRET_B');
const respond = (dispatch: ReadonlyRelayDispatch): ReadonlyRelayTransmissionResult => {
  const body = JSON.parse(dispatch.requestEnvelope.body) as { input: { content: { text: string }[] }[] };
  const text = buildReadonlyMockResponse(body.input[0]!.content[0]!.text);
  return { text, responseHash: hashReadonlyValue('synthetic collection raw SSE'), finalTextHash: hashReadonlyValue(text),
    verification: { transport: 'fake', upstreamCalls: 1, isolation: 'not_run', credentialAccess: 'not_run',
      responseValidation: 'codex-native-output-v1', relayCompleted: true, credentialReflection: 'passed' } };
};
const request = (snapshot: PersonalReadonlySnapshot) => ({ investigationId: snapshot.task.investigationId, planHash: snapshot.task.plan.planHash });
const setup = async (selectedPort?: ReadonlyRelayPort) => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'personal-collection-workflow-'))); chmodSync(directory, 0o700);
  const sourceRoot = join(directory, 'source'); const runtime = join(directory, 'runtime');
  await mkdir(join(sourceRoot, 'src'), { recursive: true, mode: 0o700 }); await mkdir(runtime, { mode: 0o700 });
  const files = { 'src/plain.ts': 'export const plain = () => "plain";\n', 'src/client.ts': originalClient,
    'src/large.ts': `// ${'x'.repeat(40 * 1024)}\nexport const large = () => "bounded";\n` };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(sourceRoot, path), content);
  await git.init({ fs, dir: sourceRoot, defaultBranch: 'main' });
  for (const path of Object.keys(files)) await git.add({ fs, dir: sourceRoot, filepath: path });
  const baseCommit = await git.commit({ fs, dir: sourceRoot, message: 'synthetic collection fixture',
    author: { name: 'Synthetic', email: 'synthetic@example.test', timestamp: 1_700_000_000, timezoneOffset: 0 } });
  const registration: PersonalReadonlyRegistration = { version: 'personal-readonly-registration-v1', repoId: 'personal-test', sourceRoot,
    baseCommit, question: 'Explain only the supplied source excerpts.', readRanges: [{ path: 'src/plain.ts', startLine: 1, endLine: 1 }], transferPaths: ['src/plain.ts'] };
  const collection: PersonalCollectionRegistration = { ...registration, version: 'personal-readonly-registration-v2', collectionPolicy: 'personal-readonly-collection-v2',
    readRanges: [{ path: 'src/client.ts', startLine: 2, endLine: 2 }, { path: 'src/large.ts', startLine: 2, endLine: 2 }], transferPaths: ['src/client.ts', 'src/large.ts'] };
  const file = join(runtime, 'personal-readonly.sqlite'); let store = new SqlitePersonalReadonlyStore(file); const received: ReadonlyRelayDispatch[] = [];
  const port: ReadonlyRelayPort = selectedPort ?? { mode: 'live', transport: 'codex-cli-relay', transmit: async (input, _signal, before, beforeCredential) => {
    beforeCredential(); before(); received.push(input); return respond(input);
  } };
  let service = new PersonalReadonlyService(store, port, runtime, config, () => true);
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date(Date.now() + 10000) };
  return { file, sourceRoot, registration, collection, context, received, get store() { return store; }, get service() { return service; },
    reopen: () => { store.close(); store = new SqlitePersonalReadonlyStore(file); service = new PersonalReadonlyService(store, port, runtime, config, () => true); },
    close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
};

test('personal v1 and collection v2 coexist, retain distinct approvals/reports and prune with durable markers after restart', async () => {
  const h = await setup();
  try {
    const old = await h.service.plan(h.registration, h.context); const next = await h.service.plan(h.collection, h.context);
    assert.equal(old.task.plan.policy, 'personal-readonly-investigation-v1'); assert.equal(next.task.plan.policy, 'personal-readonly-investigation-v2');
    assert.equal(old.task.plan.connectionProfileHash, next.task.plan.connectionProfileHash); assert.equal(old.task.plan.configHash, next.task.plan.configHash);
    assert.notEqual(old.task.plan.planHash, next.task.plan.planHash); assert.notEqual(old.task.plan.inputHash, next.task.plan.inputHash);
    assert.equal(next.task.plan.limits.fileBytes, 32768);
    assert.ok('collectionProfile' in next.task.plan); assert.equal(next.task.plan.collectionProfile.limits.sourceFileBytes, 65536);
    assert.ok('sourceViews' in next.payload!); assert.equal(next.payload.sourceViews.length, 2);
    assert.equal(next.payload.sourceViews.find(item => item.path === 'src/client.ts')!.rawSensitiveCheck, 'rejected');
    assert.equal(next.payload.sourceViews.some(item => 'bytes' in item), false);
    assert.doesNotMatch(JSON.stringify(next.payload), /SYNTHETIC_PERSONAL_SECRET_A_123456/u);
    assert.throws(() => h.service.approve({ ...request(next), planHash: old.task.plan.planHash, expiresInMinutes: 10 }, h.context), { code: 'PERSONAL_READONLY_PLAN_HASH_MISMATCH' });
    assert.throws(() => validateAnyPersonalPayload(old.task.plan, next.payload!), { code: 'PERSONAL_READONLY_INVALID_CONTRACT' });
    for (const plan of [old, next]) h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.context);
    const first = await h.service.run(request(old), h.context); const second = await h.service.run(request(next), h.context);
    assert.equal(first.task.status, 'REPORTED'); assert.equal(second.task.status, 'REPORTED'); assert.equal(h.received.length, 2);
    assert.equal('collection' in first.report!, false); assert.ok('collection' in second.report!);
    assert.deepEqual(second.report.collection, { policy: 'personal-readonly-collection-v2', profileHash: next.task.plan.collectionProfileHash,
      sourceViewsHash: next.task.plan.sourceViewsHash, evidenceOrigin: 'line-preserving-derived-view' });
    assert.equal(second.report.checks.realModel, 'not_run'); assert.equal(second.report.semanticAccuracyVerified, false);
    h.reopen(); assert.deepEqual(h.service.inspect(next.task.investigationId, h.context).report, second.report);
    const future = { ...h.context, now: new Date(Date.parse(second.task.terminalAt!) + 31 * 86400000) };
    assert.deepEqual(h.service.prune(future), { payloadsRemoved: 2, auditsRemoved: 2 });
    for (const plan of [old, next]) assert.throws(() => h.store.create(plan.task.plan, plan.payload!, h.context), { code: 'PERSONAL_READONLY_ID_REUSED' });
  } finally { await h.close(); }
});

for (const stage of ['credentials', 'network'] as const) {
  test(`collection raw-source changes with the same derived view reject at ${stage}`, async () => {
    assert.equal(derivePersonalSourceView('src/client.ts', Buffer.from(originalClient)).viewHash,
      derivePersonalSourceView('src/client.ts', Buffer.from(changedClient)).viewHash);
    let sourceRoot = ''; let credentials = 0; let network = 0;
    const h = await setup({ mode: 'live', transport: 'codex-cli-relay', transmit: async (input, _signal, before, beforeCredential) => {
      if (stage === 'credentials') writeFileSync(join(sourceRoot, 'src/client.ts'), changedClient);
      beforeCredential(); credentials++;
      if (stage === 'network') writeFileSync(join(sourceRoot, 'src/client.ts'), changedClient);
      before(); network++; return respond(input);
    } });
    try {
      sourceRoot = h.sourceRoot; const plan = await h.service.plan(h.collection, h.context);
      h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.context);
      const done = await h.service.run(request(plan), h.context);
      assert.equal(done.task.status, 'BLOCKED'); assert.equal(done.task.failureCode, 'PERSONAL_READONLY_SOURCE_CHANGED');
      assert.equal(done.report, null); assert.ok(done.approvals[0]!.usedAt); assert.equal(network, 0);
      assert.equal(credentials, stage === 'credentials' ? 0 : 1);
    } finally { await h.close(); }
  });
}

test('collection report view disclosure is required and persisted tampering is rejected', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan(h.collection, h.context); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.context);
    const done = await h.service.run(request(plan), h.context); assert.equal(done.task.status, 'REPORTED');
    const db = new DatabaseSync(h.file); const row = db.prepare('SELECT payload FROM personal_readonly_payloads WHERE investigation_id=?').get(plan.task.investigationId)!;
    const original = JSON.parse(String(row.payload));
    for (const mutation of ['missing', 'origin', 'profile', 'views'] as const) {
      const record = structuredClone(original);
      if (mutation === 'missing') delete record.report.collection;
      if (mutation === 'origin') record.report.collection.evidenceOrigin = 'original-source';
      if (mutation === 'profile') record.report.collection.profileHash = '0'.repeat(64);
      if (mutation === 'views') record.report.collection.sourceViewsHash = '0'.repeat(64);
      const payload = JSON.stringify(record); db.prepare('UPDATE personal_readonly_payloads SET payload=?,payload_hash=? WHERE investigation_id=?')
        .run(payload, hashReadonlyValue(payload), plan.task.investigationId);
      assert.throws(() => h.service.inspect(plan.task.investigationId, h.context), { code: 'PERSONAL_READONLY_INVALID_RECORD' });
    }
    const old = await h.service.plan(h.registration, h.context); h.service.approve({ ...request(old), expiresInMinutes: 10 }, h.context);
    const oldDone = await h.service.run(request(old), h.context); assert.equal(oldDone.task.status, 'REPORTED');
    const oldRow = db.prepare('SELECT payload FROM personal_readonly_payloads WHERE investigation_id=?').get(old.task.investigationId)!;
    const oldRecord = JSON.parse(String(oldRow.payload)); oldRecord.report.collection = original.report.collection;
    const oldBody = JSON.stringify(oldRecord); db.prepare('UPDATE personal_readonly_payloads SET payload=?,payload_hash=? WHERE investigation_id=?')
      .run(oldBody, hashReadonlyValue(oldBody), old.task.investigationId);
    assert.throws(() => h.service.inspect(old.task.investigationId, h.context), { code: 'PERSONAL_READONLY_INVALID_RECORD' });
    db.close();
  } finally { await h.close(); }
});

test('collection restart recovery rechecks raw source/view bindings and never restores consumed approval', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan(h.collection, h.context); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.context);
    const attempt = h.store.claim(request(plan), h.context); h.store.dispatch(plan.task.investigationId, attempt.generation, h.context, () => undefined);
    h.reopen(); const recovered = await h.service.recover(plan.task.investigationId, h.context);
    assert.equal(recovered.task.status, 'INTERRUPTED'); assert.equal(recovered.report, null); assert.ok(recovered.approvals[0]!.usedAt);
    await assert.rejects(h.service.run(request(plan), h.context), { code: 'PERSONAL_READONLY_APPROVAL_REQUIRED' }); assert.equal(h.received.length, 0);
  } finally { await h.close(); }
});

test('contract selection rejects unknown and accessor versions without invoking getters', () => {
  let reads = 0;
  assert.throws(() => parseAnyPersonalRegistration({ version: 'personal-readonly-registration-v3' }), { code: 'PERSONAL_READONLY_INVALID_CONTRACT' });
  assert.throws(() => parseAnyPersonalRegistration(Object.defineProperty({}, 'version', { enumerable: true, get() { reads++; return 'personal-readonly-registration-v2'; } })),
    { code: 'PERSONAL_READONLY_INVALID_CONTRACT' });
  assert.throws(() => parseAnyPersonalRegistration({ version: 'personal-readonly-registration-v2', [Symbol('extra')]: true }), { code: 'PERSONAL_READONLY_INVALID_CONTRACT' });
  assert.throws(() => parseAnyPersonalRegistration(Object.defineProperty({ version: 'personal-readonly-registration-v2' }, 'extra',
    { enumerable: true, get() { reads++; return 'must not run'; } })), { code: 'PERSONAL_READONLY_INVALID_CONTRACT' });
  assert.equal(reads, 0);
});
