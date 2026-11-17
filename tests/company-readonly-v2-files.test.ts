import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { companyV2RuntimeHash, prepareCompanyV2Directory, pruneCompanyV2Runs, readCompanyV2Registration, readCompanyV2Run,
  readCompanyV2RunResult, writeCompanyV2Run, writeCompanyV2RunResult, type CompanyV2Run } from '../src/cli/company-readonly-v2-files.js';
import { getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';

const fixture = (context: TestContext) => {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v2-files-')));
  fs.chmodSync(parent, 0o700); context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'runtime'), id = randomUUID();
  const run: CompanyV2Run = { version: 'company-readonly-v2-run-v1', taskId: id, ownerId: `os-user:${process.getuid?.()}`,
    startedAt: '2026-01-01T00:00:00.000Z', auditExpiresAt: '2026-01-02T00:00:00.000Z',
    gitProfileHash: getCompanyGitRangeProfileHash(), registrationHash: '1'.repeat(64), policyHash: '2'.repeat(64),
    runtimeHash: companyV2RuntimeHash(root, `os-user:${process.getuid?.()}`) };
  return { parent, root, id, run, start: join(root, 'runs', `run-${id}.json`), result: join(root, 'runs', `result-${id}.json`) };
};

test('v2 start/result records are private, durable, immutable, body-free and separately expire', async context => {
  const h = fixture(context); await prepareCompanyV2Directory(h.root, true);
  assert.deepEqual(fs.readdirSync(h.root).sort(), ['runs', 'store']);
  await writeCompanyV2Run(h.root, h.run);
  assert.deepEqual(await readCompanyV2Run(h.root, h.id), h.run);
  assert.equal(await readCompanyV2RunResult(h.root, h.id), null);
  const result = { version: 'company-readonly-v2-run-result-v1' as const, taskId: h.id, status: 'unknown' as const,
    planHash: null, endedAt: '2026-01-01T00:00:30.260Z', exitConfirmed: true };
  await writeCompanyV2RunResult(h.root, result);
  assert.deepEqual(await readCompanyV2RunResult(h.root, h.id), result);
  for (const path of [h.start, h.result]) assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  for (const path of [h.parent, h.root, join(h.root, 'runs'), join(h.root, 'store')]) assert.equal(fs.statSync(path).mode & 0o777, 0o700);
  await assert.rejects(writeCompanyV2Run(h.root, h.run));
  await assert.rejects(writeCompanyV2RunResult(h.root, result));
  assert.equal(await pruneCompanyV2Runs(h.root, new Date('2026-01-01T23:59:59.999Z')), 0);
  assert.equal(await pruneCompanyV2Runs(h.root, new Date(h.run.auditExpiresAt)), 1);
  assert.deepEqual(fs.readdirSync(join(h.root, 'runs')), []);
});

test('v2 runtime refuses foreign/v1 files and linked or public directories', async context => {
  const h = fixture(context); await prepareCompanyV2Directory(h.root, true);
  fs.writeFileSync(join(h.root, 'store', 'company-readonly.sqlite'), '', { mode: 0o600 });
  await assert.rejects(prepareCompanyV2Directory(h.root, false));
  fs.unlinkSync(join(h.root, 'store', 'company-readonly.sqlite'));
  fs.chmodSync(join(h.root, 'runs'), 0o755); await assert.rejects(prepareCompanyV2Directory(h.root, false));
  fs.chmodSync(join(h.root, 'runs'), 0o700); fs.renameSync(join(h.root, 'runs'), join(h.parent, 'moved'));
  fs.symlinkSync(join(h.parent, 'moved'), join(h.root, 'runs'));
  await assert.rejects(prepareCompanyV2Directory(h.root, false));
});

test('v2 receipt parsing refuses links, permission changes, extra fields, owner/profile changes and duplicate keys', async context => {
  const h = fixture(context); await prepareCompanyV2Directory(h.root, true); await writeCompanyV2Run(h.root, h.run);
  const original = fs.readFileSync(h.start, 'utf8');
  fs.linkSync(h.start, join(h.parent, 'hardlink')); await assert.rejects(readCompanyV2Run(h.root, h.id));
  fs.unlinkSync(join(h.parent, 'hardlink'));
  fs.chmodSync(h.start, 0o644); await assert.rejects(readCompanyV2Run(h.root, h.id)); fs.chmodSync(h.start, 0o600);
  for (const patch of [{ extra: 'body' }, { ownerId: 'os-user:999999' }, { gitProfileHash: '0'.repeat(64) }, { auditExpiresAt: h.run.startedAt }]) {
    fs.writeFileSync(h.start, JSON.stringify({ ...h.run, ...patch })); await assert.rejects(readCompanyV2Run(h.root, h.id));
  }
  fs.writeFileSync(h.start, original.replace('{', '{"version":"company-readonly-v2-run-v1",'));
  await assert.rejects(readCompanyV2Run(h.root, h.id));
  fs.unlinkSync(h.start); fs.writeFileSync(join(h.parent, 'target.json'), original, { mode: 0o600 });
  fs.symlinkSync(join(h.parent, 'target.json'), h.start); await assert.rejects(readCompanyV2Run(h.root, h.id));
});

test('v2 registration file is a distinct bounded strict UTF8 JSON input and never repairs permissions', async context => {
  const h = fixture(context), file = join(h.parent, 'company-readonly-registration-v2.json');
  fs.writeFileSync(file, '{"version":"synthetic"}', { mode: 0o600 });
  assert.deepEqual(await readCompanyV2Registration(file), { version: 'synthetic' });
  const legacy = join(h.parent, 'company-readonly-registration.json');
  fs.copyFileSync(file, legacy); await assert.rejects(readCompanyV2Registration(legacy));
  for (const body of ['{"a":1,"a":2}', ' '.repeat(64_001), Buffer.from([0xc0, 0xaf])]) {
    fs.writeFileSync(file, body); await assert.rejects(readCompanyV2Registration(file));
  }
  fs.writeFileSync(file, '{}'); fs.chmodSync(file, 0o644); await assert.rejects(readCompanyV2Registration(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});
