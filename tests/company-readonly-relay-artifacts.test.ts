import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pruneCompanyRelayArtifacts, registerCompanyRelayArtifacts } from '../src/cli/company-relay-artifacts.js';
import type { CompanyRelayAuthorization } from '../src/domain/company-relay.js';
import type { CompanyReadonlySnapshotV3 } from '../src/domain/company-readonly-v3.js';
import { createCompanyRelay } from '../src/policy/company-relay.js';
import { createCompanyReadonlyPreparationV3 } from '../src/policy/company-readonly-v3.js';
import { hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const authorization: CompanyRelayAuthorization = { version: 'company-relay-authorization-v1', enabled: true,
  companyTransmissionApproved: true, providerTermsConfirmed: true, accountIdHash: hashReadonlyValue('synthetic-account-123'),
  config: { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/codex', codexSha256: 'a'.repeat(64),
    model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 } };
const setup = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV3Fixture(context), input = fixture.prepareInput();
  const prepared = createCompanyReadonlyPreparationV3(input.registration, input.policy, input.observation, input.collected, input.budget, input.context, input.id);
  const snapshot: CompanyReadonlySnapshotV3 = { ...prepared, status: 'AWAITING_APPROVAL', updatedAt: input.context.now.toISOString(),
    approvalCreated: false, transmissionAllowed: false, executionAllowed: false, companyPolicyVerified: false };
  const { plan } = createCompanyRelay(snapshot, input.context, randomUUID(), '1'.repeat(64), authorization);
  const runtime = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-relay-artifacts-'))); fs.chmodSync(runtime, 0o700);
  const directory = join(runtime, 'readonly-relay-runs'); fs.mkdirSync(directory, { mode: 0o700 });
  context.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const manifest = join(directory, `${plan.id}.retention.json`), run = join(directory, plan.id);
  const hashes = { requestBodyHash: plan.requestBodyHash, requestEnvelopeHash: plan.requestEnvelopeHash, connectionProfileHash: plan.connectionProfileHash };
  const write = (name: string, value: unknown) => fs.writeFileSync(join(run, name), JSON.stringify(value), { mode: 0o600 });
  const closed = (report = true) => {
    fs.mkdirSync(run, { mode: 0o700 });
    write('lifecycle.json', { version: 'readonly-relay-process-v1', investigationId: plan.id, controllerPid: process.pid, state: 'closed', ...hashes });
    write('child.json', { version: 'readonly-relay-child-v1', state: 'intent', guardianPid: null, childPid: null });
    fs.writeFileSync(join(run, 'host-canary.txt'), 'synthetic isolation canary', { mode: 0o600 });
    if (report) write('call-report.json', { policy: 'company-relay-plan-v1', cleanupConfirmed: true, ...hashes });
  };
  return { runtime, directory, manifest, run, plan, write, hashes, closed, context: input.context,
    expires: { ...input.context, now: new Date(plan.auditExpiresAt) } };
};

test('artifact registration stores private fixed metadata with the original audit deadline and cannot extend it', async context => {
  const h = await setup(context);
  await registerCompanyRelayArtifacts(h.runtime, h.plan);
  const before = fs.readFileSync(h.manifest, 'utf8'), parsed = JSON.parse(before) as Record<string, unknown>;
  assert.equal(parsed.auditExpiresAt, h.plan.auditExpiresAt); assert.equal(parsed.planHash, h.plan.planHash);
  assert.equal(fs.statSync(h.manifest).mode & 0o7777, 0o600);
  assert.equal(before.includes('synthetic-account'), false); assert.equal(fs.existsSync(h.run), false);
  await registerCompanyRelayArtifacts(h.runtime, h.plan); assert.equal(fs.readFileSync(h.manifest, 'utf8'), before);
  parsed.auditExpiresAt = '2099-01-01T00:00:00.000Z'; fs.writeFileSync(h.manifest, JSON.stringify(parsed));
  await assert.rejects(registerCompanyRelayArtifacts(h.runtime, h.plan), { code: 'COMPANY_RELAY_UNSAFE_ARTIFACTS' });
  await assert.rejects(pruneCompanyRelayArtifacts(h.runtime, h.expires), { code: 'COMPANY_RELAY_UNSAFE_ARTIFACTS' });
});

test('only the expired closed and cleanup-confirmed metadata directory is removed, without recursive deletion', async context => {
  for (const report of [false, true]) {
    const h = await setup(context); await registerCompanyRelayArtifacts(h.runtime, h.plan); h.closed(report);
    assert.deepEqual(await pruneCompanyRelayArtifacts(h.runtime, h.context), { removedRuns: 0, removedManifests: 0, preservedUncertain: 0 });
    assert.equal(fs.existsSync(h.manifest), true); assert.equal(fs.existsSync(h.run), true);
    assert.deepEqual(await pruneCompanyRelayArtifacts(h.runtime, h.expires), { removedRuns: 1, removedManifests: 1, preservedUncertain: 0 });
    assert.equal(fs.existsSync(h.manifest), false); assert.equal(fs.existsSync(h.run), false); assert.equal(fs.existsSync(h.directory), true);
  }
});

test('an expired manifest without a native lifecycle is removed and does not invent a native execution', async context => {
  const h = await setup(context); await registerCompanyRelayArtifacts(h.runtime, h.plan);
  assert.deepEqual(await pruneCompanyRelayArtifacts(h.runtime, h.expires), { removedRuns: 0, removedManifests: 1, preservedUncertain: 0 });
});

test('uncertain lifecycle, scratch, unknown files and foreign report policy are retained after the audit deadline', async context => {
  for (const kind of ['intent', 'running', 'scratch', 'unknown', 'cleanup', 'policy', 'hash', 'child', 'malformed', 'canary']) {
    const h = await setup(context); await registerCompanyRelayArtifacts(h.runtime, h.plan); h.closed();
    if (kind === 'intent' || kind === 'running') h.write('lifecycle.json', { version: 'readonly-relay-process-v1', investigationId: h.plan.id,
      controllerPid: process.pid, state: kind, ...h.hashes });
    if (kind === 'scratch') fs.mkdirSync(join(h.run, 'sandbox'), { mode: 0o700 });
    if (kind === 'unknown') h.write('unexpected.json', { synthetic: true });
    if (kind === 'cleanup') h.write('call-report.json', { policy: 'company-relay-plan-v1', cleanupConfirmed: false, ...h.hashes });
    if (kind === 'policy') h.write('call-report.json', { policy: 'synthetic-readonly-relay-v1', cleanupConfirmed: true, ...h.hashes });
    if (kind === 'hash') h.write('call-report.json', { policy: 'company-relay-plan-v1', cleanupConfirmed: true, ...h.hashes, requestBodyHash: '0'.repeat(64) });
    if (kind === 'child') h.write('child.json', { version: 'readonly-relay-child-v1', state: 'spawned', guardianPid: process.pid, childPid: process.pid });
    if (kind === 'malformed') fs.writeFileSync(join(h.run, 'lifecycle.json'), '{');
    if (kind === 'canary') fs.writeFileSync(join(h.run, 'host-canary.txt'), 'changed synthetic canary');
    assert.deepEqual(await pruneCompanyRelayArtifacts(h.runtime, h.expires), { removedRuns: 0, removedManifests: 0, preservedUncertain: 1 });
    assert.equal(fs.existsSync(h.run), true); assert.equal(fs.existsSync(h.manifest), true);
  }
});

test('an orphaned native directory without company retention binding is preserved', async context => {
  const h = await setup(context); h.closed();
  assert.deepEqual(await pruneCompanyRelayArtifacts(h.runtime, h.expires), { removedRuns: 0, removedManifests: 0, preservedUncertain: 1 });
  assert.equal(fs.existsSync(h.run), true);
});

test('an interrupted manifest write stays unconfirmed instead of blocking ordinary body-retention work', async context => {
  const h = await setup(context);
  fs.writeFileSync(h.manifest, '{', { mode: 0o600 });
  assert.deepEqual(await pruneCompanyRelayArtifacts(h.runtime, h.expires), { removedRuns: 0, removedManifests: 0, preservedUncertain: 1 });
  assert.equal(fs.readFileSync(h.manifest, 'utf8'), '{');
});

test('public files, symlinks and hardlinks are rejected without repairing permissions or deleting linked targets', async context => {
  for (const kind of ['public', 'symlink', 'hardlink', 'parent']) {
    const h = await setup(context); await registerCompanyRelayArtifacts(h.runtime, h.plan); h.closed();
    const target = join(h.runtime, 'outside.json'); fs.writeFileSync(target, 'synthetic outside canary', { mode: 0o600 });
    if (kind === 'public') fs.chmodSync(h.manifest, 0o644);
    if (kind === 'symlink' || kind === 'hardlink') {
      fs.unlinkSync(h.manifest);
      if (kind === 'symlink') fs.symlinkSync(target, h.manifest); else fs.linkSync(target, h.manifest);
    }
    if (kind === 'parent') {
      fs.renameSync(h.run, join(h.runtime, 'moved')); fs.symlinkSync(join(h.runtime, 'moved'), h.run);
    }
    await assert.rejects(pruneCompanyRelayArtifacts(h.runtime, h.expires));
    assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic outside canary');
    assert.equal(fs.existsSync(h.run), true);
    if (kind === 'public') assert.equal(fs.statSync(h.manifest).mode & 0o7777, 0o644);
  }
});

test('unknown top-level names and invalid owner contexts fail before removing registered artifacts', async context => {
  const h = await setup(context); await registerCompanyRelayArtifacts(h.runtime, h.plan); h.closed();
  await assert.rejects(pruneCompanyRelayArtifacts(h.runtime, { ...h.expires, ownerId: 'os-user:9999999' }), { code: 'COMPANY_RELAY_UNSAFE_ARTIFACTS' });
  fs.writeFileSync(join(h.directory, 'unexpected.json'), '{}', { mode: 0o600 });
  await assert.rejects(pruneCompanyRelayArtifacts(h.runtime, h.expires), { code: 'COMPANY_RELAY_UNSAFE_ARTIFACTS' });
  assert.equal(fs.existsSync(h.manifest), true); assert.equal(fs.existsSync(h.run), true);
});

test('replacing validated canary or report before cleanup confirmation cannot become a newly trusted deletion identity', async context => {
  for (const name of ['host-canary.txt', 'call-report.json']) {
    const h = await setup(context); await registerCompanyRelayArtifacts(h.runtime, h.plan); h.closed();
    const target = join(h.run, name), original = fs.openSync;
    let replaced = false;
    const mocked = context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!replaced && path === join(h.run, 'lifecycle.json')) {
        replaced = true;
        fs.renameSync(target, join(h.runtime, `previous-${name}`));
        fs.writeFileSync(target, 'synthetic replacement after validation', { mode: 0o600 });
      }
      return original(path, flags, mode);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    try {
      assert.deepEqual(await pruneCompanyRelayArtifacts(h.runtime, h.expires), { removedRuns: 0, removedManifests: 0, preservedUncertain: 1 });
      assert.equal(replaced, true); assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic replacement after validation');
      assert.equal(fs.existsSync(h.manifest), true); assert.equal(fs.existsSync(join(h.run, 'lifecycle.json')), true);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
});
