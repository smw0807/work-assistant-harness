import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { companyV3RuntimeHash, prepareCompanyV3Directory, pruneCompanyV3Runs, readCompanyV3Registration, readCompanyV3Run,
  readCompanyV3RunResult, writeCompanyV3Run, writeCompanyV3RunResult, type CompanyV3Run } from '../src/cli/company-readonly-v3-files.js';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { companyV2RuntimeHash, prepareCompanyV2Directory, writeCompanyV2Run, type CompanyV2Run } from '../src/cli/company-readonly-v2-files.js';
import { getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';

const fixture = (context: TestContext) => {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-files-')));
  fs.chmodSync(parent, 0o700); context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'runtime'), id = randomUUID();
  const run: CompanyV3Run = { version: 'company-readonly-v3-run-v1', taskId: id, ownerId: `os-user:${process.getuid?.()}`,
    startedAt: '2026-01-01T00:00:00.000Z', auditExpiresAt: '2026-01-02T00:00:00.000Z',
    gitProfileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), registrationHash: '1'.repeat(64), policyHash: '2'.repeat(64),
    runtimeHash: companyV3RuntimeHash(root, `os-user:${process.getuid?.()}`) };
  return { parent, root, id, run, start: join(root, 'runs', `run-${id}.json`), result: join(root, 'runs', `result-${id}.json`) };
};

test('v3 start/result records are private, durable, immutable, body-free and separately expire', async context => {
  const h = fixture(context); await prepareCompanyV3Directory(h.root, true);
  assert.deepEqual(fs.readdirSync(h.root).sort(), ['runs', 'store']);
  await writeCompanyV3Run(h.root, h.run);
  assert.deepEqual(await readCompanyV3Run(h.root, h.id), h.run);
  assert.equal(await readCompanyV3RunResult(h.root, h.id), null);
  const result = { version: 'company-readonly-v3-run-result-v1' as const, taskId: h.id, status: 'unknown' as const,
    planHash: null, endedAt: '2026-01-01T00:00:30.260Z', exitConfirmed: true };
  await writeCompanyV3RunResult(h.root, result);
  assert.deepEqual(await readCompanyV3RunResult(h.root, h.id), result);
  for (const path of [h.start, h.result]) assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  for (const path of [h.parent, h.root, join(h.root, 'runs'), join(h.root, 'store')]) assert.equal(fs.statSync(path).mode & 0o777, 0o700);
  await assert.rejects(writeCompanyV3Run(h.root, h.run));
  await assert.rejects(writeCompanyV3RunResult(h.root, result));
  assert.equal(await pruneCompanyV3Runs(h.root, new Date('2026-01-01T23:59:59.999Z')), 0);
  assert.equal(await pruneCompanyV3Runs(h.root, new Date(h.run.auditExpiresAt)), 1);
  assert.deepEqual(fs.readdirSync(join(h.root, 'runs')), []);
});

test('v3 runtime refuses foreign/v1 files and linked or public directories', async context => {
  const h = fixture(context); await prepareCompanyV3Directory(h.root, true);
  fs.writeFileSync(join(h.root, 'store', 'company-readonly.sqlite'), '', { mode: 0o600 });
  await assert.rejects(prepareCompanyV3Directory(h.root, false));
  fs.unlinkSync(join(h.root, 'store', 'company-readonly.sqlite'));
  fs.chmodSync(join(h.root, 'runs'), 0o755); await assert.rejects(prepareCompanyV3Directory(h.root, false));
  fs.chmodSync(join(h.root, 'runs'), 0o700); fs.renameSync(join(h.root, 'runs'), join(h.parent, 'moved'));
  fs.symlinkSync(join(h.parent, 'moved'), join(h.root, 'runs'));
  await assert.rejects(prepareCompanyV3Directory(h.root, false));
});

test('v3 receipt parsing refuses links, permission changes, extra fields, owner/profile changes and duplicate keys', async context => {
  const h = fixture(context); await prepareCompanyV3Directory(h.root, true); await writeCompanyV3Run(h.root, h.run);
  const original = fs.readFileSync(h.start, 'utf8');
  fs.linkSync(h.start, join(h.parent, 'hardlink')); await assert.rejects(readCompanyV3Run(h.root, h.id));
  fs.unlinkSync(join(h.parent, 'hardlink'));
  fs.chmodSync(h.start, 0o644); await assert.rejects(readCompanyV3Run(h.root, h.id)); fs.chmodSync(h.start, 0o600);
  for (const patch of [{ extra: 'body' }, { ownerId: 'os-user:999999' }, { gitProfileHash: '0'.repeat(64) },
    { gitProfileHash: getCompanyGitRangeProfileHash() }, { guardPolicyHash: '0'.repeat(64) }, { guardPolicyHash: undefined },
    { version: 'company-readonly-v2-run-v1' }, { auditExpiresAt: h.run.startedAt }]) {
    fs.writeFileSync(h.start, JSON.stringify({ ...h.run, ...patch })); await assert.rejects(readCompanyV3Run(h.root, h.id));
  }
  fs.writeFileSync(h.start, original.replace('{', '{"version":"company-readonly-v3-run-v1",'));
  await assert.rejects(readCompanyV3Run(h.root, h.id));
  fs.unlinkSync(h.start); fs.writeFileSync(join(h.parent, 'target.json'), original, { mode: 0o600 });
  fs.symlinkSync(join(h.parent, 'target.json'), h.start); await assert.rejects(readCompanyV3Run(h.root, h.id));
});

test('v3 registration file is a distinct bounded strict UTF8 JSON input and never repairs permissions', async context => {
  const h = fixture(context), file = join(h.parent, 'company-readonly-registration-v3.json');
  fs.writeFileSync(file, '{"version":"synthetic"}', { mode: 0o600 });
  assert.deepEqual(await readCompanyV3Registration(file), { version: 'synthetic' });
  const legacy = join(h.parent, 'company-readonly-registration.json');
  fs.copyFileSync(file, legacy); await assert.rejects(readCompanyV3Registration(legacy));
  for (const body of ['{"a":1,"a":2}', ' '.repeat(64_001), Buffer.from([0xc0, 0xaf])]) {
    fs.writeFileSync(file, body); await assert.rejects(readCompanyV3Registration(file));
  }
  fs.writeFileSync(file, '{}'); fs.chmodSync(file, 0o644); await assert.rejects(readCompanyV3Registration(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test('v3 and v2 run directories reject each other without creating or rewriting records', async context => {
  const h = fixture(context);
  await prepareCompanyV2Directory(h.root, true);
  const oldRun: CompanyV2Run = { version: 'company-readonly-v2-run-v1', taskId: h.id, ownerId: h.run.ownerId,
    startedAt: h.run.startedAt, auditExpiresAt: h.run.auditExpiresAt, gitProfileHash: getCompanyGitRangeProfileHash(),
    registrationHash: h.run.registrationHash, policyHash: h.run.policyHash, runtimeHash: companyV2RuntimeHash(h.root, h.run.ownerId) };
  await writeCompanyV2Run(h.root, oldRun);
  const before = fs.readFileSync(h.start);
  assert.notEqual(h.run.runtimeHash, oldRun.runtimeHash);
  for (const create of [false, true]) await assert.rejects(prepareCompanyV3Directory(h.root, create));
  await assert.rejects(readCompanyV3Run(h.root, h.id));
  assert.deepEqual(fs.readFileSync(h.start), before);
  assert.deepEqual(fs.readdirSync(join(h.root, 'store')), []);

  const separate = join(h.parent, 'v3-runtime');
  await prepareCompanyV3Directory(separate, true);
  await writeCompanyV3Run(separate, { ...h.run, runtimeHash: companyV3RuntimeHash(separate, h.run.ownerId) });
  await assert.rejects(prepareCompanyV2Directory(separate, false));
});

test('v3 rejects the v2 database basename and registration basename before accepting their contents', async context => {
  const h = fixture(context); await prepareCompanyV3Directory(h.root, true);
  const database = join(h.root, 'store', 'company-readonly-v2.sqlite');
  fs.writeFileSync(database, 'synthetic-v2-database', { mode: 0o600 });
  await assert.rejects(prepareCompanyV3Directory(h.root, true));
  assert.equal(fs.readFileSync(database, 'utf8'), 'synthetic-v2-database');
  const registration = join(h.parent, 'company-readonly-registration-v2.json');
  fs.writeFileSync(registration, '{}', { mode: 0o600 });
  await assert.rejects(readCompanyV3Registration(registration));
});
