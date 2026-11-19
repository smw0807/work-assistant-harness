import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepCompanyV3DiagnosticsDirectory, pruneCompanyV3Diagnostics, readCompanyV3Diagnostic,
  writeCompanyV3Diagnostic } from '../src/cli/company-readonly-v3-diagnostic-files.js';
import { companyV3RuntimeHash, prepareCompanyV3Directory, pruneCompanyV3Runs, writeCompanyV3Run,
  type CompanyV3Run } from '../src/cli/company-readonly-v3-files.js';
import { CompanyGitRangeUnitBudget, extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitProfile,
  getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { prepCompanyV2DiagnosticsDirectory } from '../src/cli/company-readonly-v2-diagnostic-files.js';

const unsafe = { code: 'COMPANY_READONLY_V3_UNSAFE_DIAGNOSTIC_FILE' };
const failedOutcome = { reason: 'worker_failed' as const, exitConfirmed: true };
const fixture = async (context: TestContext) => {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-diagnostics-')));
  fs.chmodSync(parent, 0o700);
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const runtime = join(parent, 'runtime'), directory = join(parent, 'diagnostics'), taskId = randomUUID();
  const run: CompanyV3Run = { version: 'company-readonly-v3-run-v1', taskId, ownerId: `os-user:${process.getuid?.()}`,
    startedAt: '2026-01-01T00:00:00.000Z', auditExpiresAt: '2026-01-02T00:00:00.000Z',
    gitProfileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), registrationHash: '1'.repeat(64), policyHash: '2'.repeat(64),
    runtimeHash: companyV3RuntimeHash(runtime, `os-user:${process.getuid?.()}`) };
  await prepareCompanyV3Directory(runtime, true);
  await writeCompanyV3Run(runtime, run);
  await prepCompanyV3DiagnosticsDirectory(directory, runtime, true);
  const path = join(directory, `diagnostic-v3-${taskId}.json`);
  return { parent, runtime, directory, run, path };
};
const failureFixture = () => {
  const budget = new CompanyGitRangeUnitBudget(0), maximum = getCompanyGitRangeUnitProfile().limits.packBytes;
  budget.beginPass('inspect', 0);
  budget.setStage('pack_index');
  try { budget.failLimit('packBytes', maximum, 1, maximum); }
  catch (error) {
    const failure = extractCompanyGitRangeUnitFailure(error);
    assert.ok(failure);
    return failure;
  }
};
const resign = (value: Record<string, unknown>): string => {
  const content = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'diagnosticHash'));
  return `${JSON.stringify({ ...content, diagnosticHash: hashReadonlyValue(canonicalReadonlyJson(content)) })}\n`;
};

test('v3 diagnostics write a private bounded immutable record bound to run and both directories', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  const failure = failureFixture();
  assert.ok(failure);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, failure);
  const record = await readCompanyV3Diagnostic(directory, runtime, run.taskId);
  assert.deepEqual(Object.keys(record).sort(), ['version', 'taskId', 'ownerId', 'gitProfileHash', 'guardPolicyHash', 'runtimeHash', 'diagnosticsDirectoryHash', 'createdAt',
    'auditExpiresAt', 'reason', 'exitConfirmed', 'failure', 'diagnosticHash'].sort());
  assert.equal(record.version, 'company-readonly-v3-diagnostic-record-v1');
  assert.equal(record.runtimeHash, run.runtimeHash);
  assert.equal(record.auditExpiresAt, run.auditExpiresAt);
  assert.equal(record.reason, 'worker_failed');
  assert.equal(record.exitConfirmed, true);
  assert.deepEqual(record.failure, failure);
  const { diagnosticHash, ...content } = record;
  assert.equal(diagnosticHash, hashReadonlyValue(canonicalReadonlyJson(content)));
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path).nlink, 1);
  assert.ok(fs.statSync(path).size <= 8192);
  assert.equal(fs.readFileSync(path, 'utf8').includes(directory), false);
  assert.equal(fs.readFileSync(path, 'utf8').includes(runtime), false);
  await prepareCompanyV3Directory(runtime, false);
});

test('v3 diagnostics permit null failure for a supervisor-only outcome', async context => {
  const { directory, runtime, run } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, { reason: 'deadline', exitConfirmed: false }, null);
  const record = await readCompanyV3Diagnostic(directory, runtime, run.taskId);
  assert.equal(record.failure, null);
  assert.equal(record.reason, 'deadline');
  assert.equal(record.exitConfirmed, false);
});

test('v3 diagnostic writes refuse an existing record without changing its bytes', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  const before = fs.readFileSync(path);
  await assert.rejects(writeCompanyV3Diagnostic(directory, runtime, run, { reason: 'completed', exitConfirmed: true }, null), unsafe);
  assert.deepEqual(fs.readFileSync(path), before);
});

test('v3 diagnostic writes reject a run different from its immutable startup record', async context => {
  const { directory, runtime, run } = await fixture(context);
  await assert.rejects(writeCompanyV3Diagnostic(directory, runtime, { ...run, auditExpiresAt: '2027-01-01T00:00:00.000Z' }, failedOutcome, null), unsafe);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('v3 diagnostic preparation neither prunes expired records nor creates a missing directory for read-only use', async context => {
  const { parent, directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  await prepCompanyV3DiagnosticsDirectory(directory, runtime, true);
  assert.ok(fs.existsSync(path));
  const absent = join(parent, 'absent');
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(absent, runtime, false), unsafe);
  assert.equal(fs.existsSync(absent), false);
});

test('v3 diagnostics prune exactly at the run audit expiry, including after run pruning', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  assert.equal(await pruneCompanyV3Diagnostics(directory, runtime, new Date(Date.parse(run.auditExpiresAt) - 1)), 0);
  assert.ok(fs.existsSync(path));
  assert.equal(await pruneCompanyV3Runs(runtime, new Date(run.auditExpiresAt)), 1);
  assert.equal((await readCompanyV3Diagnostic(directory, runtime, run.taskId)).taskId, run.taskId);
  assert.equal(await pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), 1);
  assert.equal(fs.existsSync(path), false);
  assert.equal(await pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), 0);
});

test('v3 diagnostics reject invalid pruning time without deleting records', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date(Number.NaN)), unsafe);
  assert.ok(fs.existsSync(path));
});

test('v3 diagnostics reject tampering before pruning any expired record', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  const otherRun = { ...run, taskId: randomUUID() };
  await writeCompanyV3Run(runtime, otherRun);
  await writeCompanyV3Diagnostic(directory, runtime, otherRun, failedOutcome, null);
  const otherPath = join(directory, `diagnostic-v3-${otherRun.taskId}.json`);
  const value = JSON.parse(fs.readFileSync(otherPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(otherPath, JSON.stringify({ ...value, reason: 'deadline' }));
  await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
  assert.ok(fs.existsSync(path));
  assert.ok(fs.existsSync(otherPath));
});

for (const change of [
  { name: 'additional raw error field', edit: (value: Record<string, unknown>) => { value.error = '/private/company/source.ts'; } },
  { name: 'different owner', edit: (value: Record<string, unknown>) => { value.ownerId = 'os-user:999999999'; } },
  { name: 'v2 record version', edit: (value: Record<string, unknown>) => { value.version = 'company-readonly-v2-diagnostic-record-v1'; } },
  { name: 'v1 reader profile', edit: (value: Record<string, unknown>) => { value.gitProfileHash = getCompanyGitRangeProfileHash(); } },
  { name: 'different guard', edit: (value: Record<string, unknown>) => { value.guardPolicyHash = '0'.repeat(64); } },
  { name: 'missing guard', edit: (value: Record<string, unknown>) => { delete value.guardPolicyHash; } },
  { name: 'wrong task', edit: (value: Record<string, unknown>) => { value.taskId = randomUUID(); } },
  { name: 'unrecognized reason', edit: (value: Record<string, unknown>) => { value.reason = 'raw worker error'; } },
  { name: 'noncanonical expiry', edit: (value: Record<string, unknown>) => { value.auditExpiresAt = '2026-01-02'; } },
  { name: 'invalid numeric failure', edit: (value: Record<string, unknown>) => { value.failure = { ...failureFixture(), stack: 'raw stack' }; } },
]) {
  test(`v3 diagnostics reject ${change.name} even with a recomputed content hash`, async context => {
    const { directory, runtime, run, path } = await fixture(context);
    await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
    const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    change.edit(value);
    fs.writeFileSync(path, resign(value));
    await assert.rejects(readCompanyV3Diagnostic(directory, runtime, run.taskId), unsafe);
  });
}

test('v3 diagnostics reject duplicate JSON keys and oversized files', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  const text = fs.readFileSync(path, 'utf8');
  fs.writeFileSync(path, text.replace('"reason":', '"reason":"completed","reason":'));
  await assert.rejects(readCompanyV3Diagnostic(directory, runtime, run.taskId), unsafe);
  fs.writeFileSync(path, `${text}${' '.repeat(8192)}`);
  await assert.rejects(readCompanyV3Diagnostic(directory, runtime, run.taskId), unsafe);
});

test('v3 diagnostic copies into another directory are rejected before writing or pruning', async context => {
  const { parent, directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  const moved = join(parent, 'moved-diagnostics');
  fs.mkdirSync(moved, { mode: 0o700 });
  const movedPath = join(moved, `diagnostic-v3-${run.taskId}.json`);
  fs.copyFileSync(path, movedPath);
  fs.chmodSync(movedPath, 0o600);
  const otherRun = { ...run, taskId: randomUUID() };
  await writeCompanyV3Run(runtime, otherRun);
  const before = fs.readFileSync(movedPath);
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(moved, runtime, true), unsafe);
  await assert.rejects(writeCompanyV3Diagnostic(moved, runtime, otherRun, failedOutcome, null), unsafe);
  await assert.rejects(pruneCompanyV3Diagnostics(moved, runtime, new Date(run.auditExpiresAt)), unsafe);
  assert.deepEqual(fs.readdirSync(moved), [`diagnostic-v3-${run.taskId}.json`]);
  assert.deepEqual(fs.readFileSync(movedPath), before);
});

test('v3 diagnostics reject a renamed directory and a different runtime location', async context => {
  const { parent, directory, runtime, run } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(directory, join(parent, 'other-runtime'), false), unsafe);
  const moved = join(parent, 'renamed-diagnostics');
  fs.renameSync(directory, moved);
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(moved, runtime, true), unsafe);
  assert.equal(fs.readdirSync(moved).length, 1);
});

test('v3 diagnostics reject runtime overlap before creating anything', async context => {
  const { parent, runtime } = await fixture(context);
  const nested = join(runtime, 'diagnostics');
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(nested, runtime, true), unsafe);
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(runtime, runtime, true), unsafe);
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(parent, runtime, true), unsafe);
  assert.equal(fs.existsSync(nested), false);
  assert.deepEqual(fs.readdirSync(runtime).sort(), ['runs', 'store']);
});

for (const kind of ['file-symlink', 'file-hardlink', 'public-file', 'public-directory', 'foreign-file', 'foreign-directory'] as const) {
  test(`v3 diagnostics reject ${kind} without changing the directory`, async context => {
    const { parent, directory, runtime, run, path } = await fixture(context);
    await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
    if (kind === 'file-symlink') {
      const outside = join(parent, 'outside.json');
      fs.renameSync(path, outside); fs.symlinkSync(outside, path);
    } else if (kind === 'file-hardlink') fs.linkSync(path, join(parent, 'linked.json'));
    else if (kind === 'public-file') fs.chmodSync(path, 0o644);
    else if (kind === 'public-directory') fs.chmodSync(directory, 0o755);
    else if (kind === 'foreign-file') fs.writeFileSync(join(directory, 'foreign.json'), '{}', { mode: 0o600 });
    else fs.mkdirSync(join(directory, 'foreign-directory'), { mode: 0o700 });
    const names = fs.readdirSync(directory);
    await assert.rejects(prepCompanyV3DiagnosticsDirectory(directory, runtime, true), unsafe);
    await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
    assert.deepEqual(fs.readdirSync(directory), names);
  });
}

test('v3 diagnostics reject symlink ancestors and public parents before directory creation', async context => {
  const { parent, runtime } = await fixture(context);
  const privateParent = join(parent, 'private-parent'), linked = join(parent, 'linked-parent');
  fs.mkdirSync(privateParent, { mode: 0o700 }); fs.symlinkSync(privateParent, linked);
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(join(linked, 'diagnostics'), runtime, true), unsafe);
  assert.deepEqual(fs.readdirSync(privateParent), []);
  fs.chmodSync(privateParent, 0o755);
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(join(privateParent, 'diagnostics'), runtime, true), unsafe);
  assert.deepEqual(fs.readdirSync(privateParent), []);
});

test('v3 diagnostics stop at the file count cap without deleting oversized collections', async context => {
  const { directory, runtime } = await fixture(context);
  for (let index = 0; index < 8193; index += 1) {
    fs.writeFileSync(join(directory, `diagnostic-v3-${randomUUID()}.json`), '{}', { mode: 0o600 });
  }
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(directory, runtime, false), unsafe);
  await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date()), unsafe);
  assert.equal(fs.readdirSync(directory).length, 8193);
});

test('v3 diagnostic names reject the old namespace and v2 cannot accept a v3 directory', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  const original = fs.readFileSync(path);
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(directory, runtime, false));
  const oldName = join(directory, `diagnostic-${run.taskId}.json`);
  fs.renameSync(path, oldName);
  await assert.rejects(prepCompanyV3DiagnosticsDirectory(directory, runtime, true), unsafe);
  await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
  assert.deepEqual(fs.readFileSync(oldName), original);
  assert.equal(fs.existsSync(path), false);
});

test('a fixed worker failure creates a version-two record with the original retention and no raw error', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run,
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' }, null);
  const record = await readCompanyV3Diagnostic(directory, runtime, run.taskId);
  assert.equal(record.version, 'company-readonly-v3-diagnostic-record-v2');
  assert.equal(record.workerFailureCode, 'COMPANY_GIT_RANGE_SOURCE_CHANGED');
  assert.equal(record.failure, null); assert.equal(record.auditExpiresAt, run.auditExpiresAt);
  assert.equal(record.reason, 'worker_failed'); assert.equal(record.exitConfirmed, true);
  const { diagnosticHash, ...content } = record;
  assert.equal(diagnosticHash, hashReadonlyValue(canonicalReadonlyJson(content)));
  assert.equal(fs.statSync(path).mode & 0o777, 0o600); assert.ok(fs.statSync(path).size <= 8192);
  for (const value of [directory, runtime, '"stack"', '"message"']) assert.equal(fs.readFileSync(path, 'utf8').includes(value), false);
  await assert.rejects(writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null), unsafe);
});

test('legacy and coded diagnostic records coexist without rewriting old hashes and prune at the same expiry', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  const legacyBytes = fs.readFileSync(path), codedRun = { ...run, taskId: randomUUID() };
  await writeCompanyV3Run(runtime, codedRun);
  await writeCompanyV3Diagnostic(directory, runtime, codedRun,
    { ...failedOutcome, workerFailureCode: 'COMPANY_READONLY_V3_PREPARATION_FAILED' }, null);
  const legacy = await readCompanyV3Diagnostic(directory, runtime, run.taskId);
  assert.equal(legacy.version, 'company-readonly-v3-diagnostic-record-v1');
  assert.equal(Object.hasOwn(legacy, 'workerFailureCode'), false);
  assert.equal((await readCompanyV3Diagnostic(directory, runtime, codedRun.taskId)).version, 'company-readonly-v3-diagnostic-record-v2');
  await prepCompanyV3DiagnosticsDirectory(directory, runtime, false);
  assert.deepEqual(fs.readFileSync(path), legacyBytes);
  assert.equal(await pruneCompanyV3Diagnostics(directory, runtime, new Date(Date.parse(run.auditExpiresAt) - 1)), 0);
  assert.deepEqual(fs.readFileSync(path), legacyBytes);
  assert.equal(await pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), 2);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('worker failure writes reject unknown codes or a non-failure outcome before creating a record', async context => {
  const { directory, runtime, run } = await fixture(context);
  for (const changed of [
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_PRIVATE_BODY' },
    { ...failedOutcome, workerFailureCode: null },
    { ...failedOutcome, workerFailureCode: '/synthetic/private/source.ts' },
    { reason: 'completed', exitConfirmed: true, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' },
    { reason: 'deadline', exitConfirmed: true, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' },
    { reason: 'invalid_output', exitConfirmed: true, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' },
    { reason: 'worker_failed', exitConfirmed: false, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' },
  ]) {
    await assert.rejects(writeCompanyV3Diagnostic(directory, runtime, run,
      changed as Parameters<typeof writeCompanyV3Diagnostic>[3], null), unsafe);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

for (const change of [
  { name: 'legacy version with a new code', edit: (value: Record<string, unknown>) => { value.version = 'company-readonly-v3-diagnostic-record-v1'; } },
  { name: 'new version missing its code', edit: (value: Record<string, unknown>) => { delete value.workerFailureCode; } },
  { name: 'null worker code', edit: (value: Record<string, unknown>) => { value.workerFailureCode = null; } },
  { name: 'unknown worker code', edit: (value: Record<string, unknown>) => { value.workerFailureCode = 'COMPANY_GIT_RANGE_PRIVATE_BODY'; } },
  { name: 'raw worker message', edit: (value: Record<string, unknown>) => { value.message = 'SYNTHETIC_PRIVATE_MESSAGE'; } },
  { name: 'successful worker code', edit: (value: Record<string, unknown>) => { value.reason = 'completed'; } },
  { name: 'unconfirmed worker code', edit: (value: Record<string, unknown>) => { value.exitConfirmed = false; } },
]) {
  test(`coded diagnostics reject ${change.name} even with a recomputed hash`, async context => {
    const { directory, runtime, run, path } = await fixture(context);
    await writeCompanyV3Diagnostic(directory, runtime, run,
      { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' }, null);
    const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    change.edit(value); fs.writeFileSync(path, resign(value));
    await assert.rejects(readCompanyV3Diagnostic(directory, runtime, run.taskId), unsafe);
    await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
    assert.ok(fs.existsSync(path));
  });
}

test('the content hash binds the worker failure code and rejects a replacement from the allowlist', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run,
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' }, null);
  const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path, JSON.stringify({ ...value, workerFailureCode: 'COMPANY_READONLY_V3_PREPARATION_FAILED' }));
  await assert.rejects(readCompanyV3Diagnostic(directory, runtime, run.taskId), unsafe);
  await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
  assert.ok(fs.existsSync(path));
});

test('a budget diagnostic must agree with its worker code on write and on record read', async context => {
  const { directory, runtime, run, path } = await fixture(context), failure = failureFixture();
  assert.ok(failure);
  await assert.rejects(writeCompanyV3Diagnostic(directory, runtime, run,
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' }, failure), unsafe);
  assert.equal(fs.existsSync(path), false);
  await writeCompanyV3Diagnostic(directory, runtime, run,
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_LIMIT' }, failure);
  const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
  value.workerFailureCode = 'COMPANY_GIT_RANGE_SOURCE_CHANGED'; fs.writeFileSync(path, resign(value));
  await assert.rejects(readCompanyV3Diagnostic(directory, runtime, run.taskId), unsafe);
});

test('a source reason creates a version-three record with only its fixed matching code and original retention', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run,
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: 'tree_selection' }, null);
  const record = await readCompanyV3Diagnostic(directory, runtime, run.taskId);
  assert.equal(record.version, 'company-readonly-v3-diagnostic-record-v3');
  assert.equal(record.workerFailureCode, 'COMPANY_GIT_RANGE_INVALID_SOURCE');
  assert.equal(record.sourceFailureReason, 'tree_selection');
  assert.equal(record.failure, null); assert.equal(record.auditExpiresAt, run.auditExpiresAt);
  assert.deepEqual(Object.keys(record).sort(), ['version', 'taskId', 'ownerId', 'gitProfileHash', 'guardPolicyHash', 'runtimeHash',
    'diagnosticsDirectoryHash', 'createdAt', 'auditExpiresAt', 'reason', 'exitConfirmed', 'failure', 'diagnosticHash',
    'workerFailureCode', 'sourceFailureReason'].sort());
  const { diagnosticHash, ...content } = record;
  assert.equal(diagnosticHash, hashReadonlyValue(canonicalReadonlyJson(content)));
  assert.equal(fs.statSync(path).mode & 0o777, 0o600); assert.ok(fs.statSync(path).size <= 8192);
  for (const text of [directory, runtime, '"message"', '"stack"', '"path"']) assert.equal(fs.readFileSync(path, 'utf8').includes(text), false);
});

test('three diagnostic record versions coexist with unchanged old bytes and the same expiry rules', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run, failedOutcome, null);
  const legacyBytes = fs.readFileSync(path), codedRun = { ...run, taskId: randomUUID() }, detailedRun = { ...run, taskId: randomUUID() };
  await writeCompanyV3Run(runtime, codedRun); await writeCompanyV3Run(runtime, detailedRun);
  await writeCompanyV3Diagnostic(directory, runtime, codedRun, { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE' }, null);
  const codedPath = join(directory, `diagnostic-v3-${codedRun.taskId}.json`), codedBytes = fs.readFileSync(codedPath);
  await writeCompanyV3Diagnostic(directory, runtime, detailedRun,
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: 'head_ref' }, null);
  assert.equal((await readCompanyV3Diagnostic(directory, runtime, run.taskId)).version, 'company-readonly-v3-diagnostic-record-v1');
  assert.equal((await readCompanyV3Diagnostic(directory, runtime, codedRun.taskId)).version, 'company-readonly-v3-diagnostic-record-v2');
  assert.equal((await readCompanyV3Diagnostic(directory, runtime, detailedRun.taskId)).version, 'company-readonly-v3-diagnostic-record-v3');
  await prepCompanyV3DiagnosticsDirectory(directory, runtime, false);
  assert.deepEqual(fs.readFileSync(path), legacyBytes); assert.deepEqual(fs.readFileSync(codedPath), codedBytes);
  assert.equal(await pruneCompanyV3Diagnostics(directory, runtime, new Date(Date.parse(run.auditExpiresAt) - 1)), 0);
  assert.deepEqual(fs.readFileSync(path), legacyBytes); assert.deepEqual(fs.readFileSync(codedPath), codedBytes);
  assert.equal(await pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), 3);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('source reason writes reject absent or conflicting codes, unknown reasons and budget diagnostics', async context => {
  const { directory, runtime, run } = await fixture(context);
  for (const changed of [
    { ...failedOutcome, sourceFailureReason: 'excerpt' },
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_SOURCE_CHANGED', sourceFailureReason: 'excerpt' },
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: undefined },
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: null },
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: 'SYNTHETIC_PRIVATE_TEXT' },
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: { reason: 'excerpt' } },
  ]) {
    await assert.rejects(writeCompanyV3Diagnostic(directory, runtime, run,
      changed as Parameters<typeof writeCompanyV3Diagnostic>[3], null), unsafe);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  const failure = failureFixture(); assert.ok(failure);
  await assert.rejects(writeCompanyV3Diagnostic(directory, runtime, run,
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: 'excerpt' }, failure), unsafe);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('outcome and reason property hooks are rejected without evaluating or persisting them', async context => {
  const { directory, runtime, run } = await fixture(context);
  const valid = { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE' as const, sourceFailureReason: 'safe_view' as const };
  let accesses = 0;
  const hostile = (): never => { accesses++; throw new Error('SYNTHETIC_PRIVATE_HOOK'); };
  const proxy = new Proxy(valid, { get: hostile, getPrototypeOf: hostile, getOwnPropertyDescriptor: hostile });
  const revoked = Proxy.revocable(valid, {}); revoked.revoke();
  const values: unknown[] = [proxy, revoked.proxy,
    { ...valid, sourceFailureReason: { toJSON: hostile } },
    { ...valid, sourceFailureReason: new Proxy({}, { get: hostile, getPrototypeOf: hostile }) }];
  for (const name of ['reason', 'exitConfirmed', 'workerFailureCode', 'sourceFailureReason']) {
    values.push(Object.defineProperty({ ...valid }, name, { enumerable: true, get: hostile }));
  }
  for (const changed of values) {
    await assert.rejects(writeCompanyV3Diagnostic(directory, runtime, run,
      changed as Parameters<typeof writeCompanyV3Diagnostic>[3], null), unsafe);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  assert.equal(accesses, 0);
});

for (const change of [
  { name: 'version one with a source reason', edit: (value: Record<string, unknown>) => { value.version = 'company-readonly-v3-diagnostic-record-v1'; } },
  { name: 'version two with a source reason', edit: (value: Record<string, unknown>) => { value.version = 'company-readonly-v3-diagnostic-record-v2'; } },
  { name: 'missing source reason', edit: (value: Record<string, unknown>) => { delete value.sourceFailureReason; } },
  { name: 'missing source code', edit: (value: Record<string, unknown>) => { delete value.workerFailureCode; } },
  { name: 'conflicting source code', edit: (value: Record<string, unknown>) => { value.workerFailureCode = 'COMPANY_GIT_RANGE_SOURCE_CHANGED'; } },
  { name: 'unknown source reason', edit: (value: Record<string, unknown>) => { value.sourceFailureReason = 'SYNTHETIC_PRIVATE_REASON'; } },
  { name: 'null source reason', edit: (value: Record<string, unknown>) => { value.sourceFailureReason = null; } },
  { name: 'raw path addition', edit: (value: Record<string, unknown>) => { value.path = '/synthetic/private/source'; } },
  { name: 'successful source failure', edit: (value: Record<string, unknown>) => { value.reason = 'completed'; } },
  { name: 'unconfirmed source failure', edit: (value: Record<string, unknown>) => { value.exitConfirmed = false; } },
]) {
  test(`source diagnostics reject ${change.name} even with a recomputed hash`, async context => {
    const { directory, runtime, run, path } = await fixture(context);
    await writeCompanyV3Diagnostic(directory, runtime, run,
      { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: 'object_lookup' }, null);
    const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    change.edit(value); fs.writeFileSync(path, resign(value));
    await assert.rejects(readCompanyV3Diagnostic(directory, runtime, run.taskId), unsafe);
    await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
    assert.ok(fs.existsSync(path));
  });
}

test('the stored hash binds the exact source failure reason', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV3Diagnostic(directory, runtime, run,
    { ...failedOutcome, workerFailureCode: 'COMPANY_GIT_RANGE_INVALID_SOURCE', sourceFailureReason: 'safe_view' }, null);
  const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path, JSON.stringify({ ...value, sourceFailureReason: 'excerpt' }));
  await assert.rejects(readCompanyV3Diagnostic(directory, runtime, run.taskId), unsafe);
  await assert.rejects(pruneCompanyV3Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
  assert.ok(fs.existsSync(path));
});
