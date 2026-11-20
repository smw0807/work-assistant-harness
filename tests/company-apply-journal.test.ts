import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claimCompanyApply, CompanyApplyJournal, observeCompanyApplyJournal, readCompanyApplyClaim,
  readCompanyApplyPrivateFile, writeCompanyApplyPrivateFile } from '../src/adapters/company-apply-journal.js';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyApplyFixture } from './company-apply-fixture.js';

const fixture = () => {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'harness-apply-journal-')); fs.chmodSync(root, 0o700);
  const directory = join(root, 'task'); fs.mkdirSync(directory, { mode: 0o700 });
  return { ...createCompanyApplyFixture(new Date()), root, directory,
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test('local apply approval is consumed once, snapshots caller data, and rejects copied claim storage', async () => {
  const f = fixture();
  try {
    const originalHash = f.plan.planHash, pending = claimCompanyApply(f.directory, f.plan, f.approval);
    f.plan.branch = 'fix/mutated-after-call'; f.approval.planHash = 'a'.repeat(64); await pending;
    const claim = await readCompanyApplyClaim(f.directory);
    assert.equal(claim.version, 'company-apply-claim-v1'); assert.equal(claim.plan.planHash, originalHash);
    assert.equal(claim.plan.branch, 'fix/synthetic-change'); assert.notEqual(claim.approval.usedAt, null);
    await assert.rejects(claimCompanyApply(f.directory, claim.plan, { ...claim.approval, usedAt: null }), { code: 'EEXIST' });
    const copy = join(f.root, 'copy'); fs.cpSync(f.directory, copy, { recursive: true }); fs.chmodSync(copy, 0o700);
    await assert.rejects(readCompanyApplyClaim(copy), { code: 'COMPANY_APPLY_INVALID_CLAIM' });
    const body = fs.readFileSync(join(f.directory, 'claim.json'), 'utf8');
    for (const privateValue of [f.registration.sourceRoot, f.draft.objective, ...f.draft.changes.map(change => change.content)]) {
      assert.equal(body.includes(privateValue), false);
    }
    assert.equal(fs.statSync(join(f.directory, 'claim.json')).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test('invalid, expired and old-scope approval cannot create or consume local apply state', async () => {
  const f = fixture();
  try {
    for (const variant of ['expired', 'owner', 'used', 'hash', 'version', 'scope'] as const) {
      const approval: unknown = variant === 'scope' ? { ...f.approval, scope: 'synthetic-validation' }
        : variant === 'version' ? { ...f.approval, version: 'company-write-approval-v1' }
          : { ...f.approval, ...(variant === 'owner' ? { ownerId: 'os-user:999999' } : {}),
            ...(variant === 'used' ? { usedAt: f.approval.createdAt } : {}), ...(variant === 'hash' ? { planHash: 'a'.repeat(64) } : {}) };
      await assert.rejects(claimCompanyApply(f.directory, f.plan, approval as typeof f.approval,
        variant === 'expired' ? new Date(f.approval.expiresAt) : new Date()));
      assert.deepEqual(fs.readdirSync(f.directory), []);
    }
  } finally { f.close(); }
});

test('INTENT without DONE stays interrupted and partial or changed journal content fails closed', async () => {
  const f = fixture();
  try {
    await claimCompanyApply(f.directory, f.plan, f.approval);
    const journal = await CompanyApplyJournal.open(f.directory);
    try {
      await journal.record('branch', null, 'INTENT');
      await assert.rejects(journal.record('file', f.plan.changes[0]!.path, 'DONE'), { code: 'COMPANY_APPLY_INVALID_JOURNAL' });
      await assert.rejects(journal.record('branch', null, 'DONE'), { code: 'COMPANY_APPLY_JOURNAL_UNAVAILABLE' });
    } finally { await journal.close(); }
    assert.equal((await observeCompanyApplyJournal(f.directory)).status, 'INTERRUPTED');
    const file = join(f.directory, 'journal.jsonl'), original = fs.readFileSync(file);
    fs.appendFileSync(file, '{');
    await assert.rejects(observeCompanyApplyJournal(f.directory), { code: 'COMPANY_APPLY_INCOMPLETE_JOURNAL' });
    fs.writeFileSync(file, original.toString().replace('INTENT', 'DONE'));
    await assert.rejects(observeCompanyApplyJournal(f.directory), { code: 'COMPANY_APPLY_INVALID_JOURNAL' });
    fs.writeFileSync(file, original); fs.chmodSync(file, 0o644);
    await assert.rejects(observeCompanyApplyJournal(f.directory), { code: 'COMPANY_APPLY_UNSAFE_STORAGE' });
  } finally { f.close(); }
});

test('a replaced journal inode and any second worker are rejected without overwriting surviving files', async () => {
  const f = fixture();
  try {
    await claimCompanyApply(f.directory, f.plan, f.approval);
    const journal = await CompanyApplyJournal.open(f.directory), file = join(f.directory, 'journal.jsonl');
    try {
      fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, '', { mode: 0o600 });
      await assert.rejects(journal.record('branch', null, 'INTENT'), { code: 'COMPANY_APPLY_STORAGE_CHANGED' });
      assert.equal(fs.readFileSync(file, 'utf8'), '');
    } finally { await journal.close(); }
    await assert.rejects(CompanyApplyJournal.open(f.directory), { code: 'EEXIST' });
    assert.equal(fs.existsSync(join(f.directory, 'claim.json')), true);
  } finally { f.close(); }
});

test('completion records ordered branch and files while mutation start after expiry is refused', async () => {
  for (const complete of [false, true]) {
    const f = fixture();
    try {
      const claim = await claimCompanyApply(f.directory, f.plan, f.approval);
      assert.equal((await observeCompanyApplyJournal(f.directory)).status, 'CLAIMED');
      const journal = await CompanyApplyJournal.open(f.directory), start = new Date(claim.approval.usedAt!);
      try {
        await journal.record('branch', null, 'INTENT', start);
        await journal.record('branch', null, 'DONE', start);
        if (!complete) {
          await assert.rejects(journal.record('file', f.plan.changes[0]!.path, 'INTENT', new Date(f.approval.expiresAt)),
            { code: 'COMPANY_APPLY_INVALID_JOURNAL' });
        } else {
          for (const [index, change] of f.plan.changes.entries()) {
            await journal.record('file', change.path, 'INTENT', start);
            await journal.record('file', change.path, 'DONE', index === f.plan.changes.length - 1 ? new Date(f.approval.expiresAt) : start);
          }
          await journal.record('result', null, 'APPLIED', new Date(f.approval.expiresAt));
        }
      } finally { await journal.close(); }
      const result = await observeCompanyApplyJournal(f.directory);
      assert.equal(result.status, complete ? 'APPLIED' : 'INTERRUPTED');
      assert.equal(result.journal.length, complete ? 2 * (f.plan.changes.length + 1) + 1 : 2);
      await assert.rejects(CompanyApplyJournal.open(f.directory), { code: 'COMPANY_APPLY_ALREADY_STARTED' });
    } finally { f.close(); }
  }
});

test('failed terminal record preserves a partial intent and does not imply a rollback or product check', async () => {
  const f = fixture();
  try {
    await claimCompanyApply(f.directory, f.plan, f.approval);
    const journal = await CompanyApplyJournal.open(f.directory);
    try {
      await journal.record('branch', null, 'INTENT'); await journal.record('result', null, 'FAILED');
    } finally { await journal.close(); }
    const result = await observeCompanyApplyJournal(f.directory);
    assert.equal(result.status, 'FAILED'); assert.equal(result.approvalConsumed, true);
    assert.deepEqual(result.journal.map(entry => entry.state), ['INTENT', 'FAILED']);
    assert.equal((await readCompanyApplyClaim(f.directory)).plan.checks, 'not_run');
  } finally { f.close(); }
});

test('metadata-only private file helpers enforce bounded canonical paths, permissions and exclusive publication', async () => {
  const f = fixture();
  try {
    await writeCompanyApplyPrivateFile(f.directory, 'plan.json', f.plan);
    assert.equal(await readCompanyApplyPrivateFile(join(f.directory, 'plan.json')), `${canonicalReadonlyJson(f.plan)}\n`);
    await assert.rejects(writeCompanyApplyPrivateFile(f.directory, 'plan.json', f.plan), { code: 'EEXIST' });
    await assert.rejects(writeCompanyApplyPrivateFile(f.directory, 'large.json', 'x'.repeat(32_769)), { code: 'COMPANY_APPLY_INVALID_JOURNAL' });
    await assert.rejects(readCompanyApplyPrivateFile(`${f.directory}/../task/plan.json`), { code: 'COMPANY_APPLY_UNSAFE_STORAGE' });
    fs.symlinkSync(join(f.directory, 'plan.json'), join(f.directory, 'link.json'));
    await assert.rejects(readCompanyApplyPrivateFile(join(f.directory, 'link.json')), { code: 'COMPANY_APPLY_UNSAFE_STORAGE' });
    fs.chmodSync(f.directory, 0o755);
    await assert.rejects(readCompanyApplyPrivateFile(join(f.directory, 'plan.json')), { code: 'COMPANY_APPLY_UNSAFE_STORAGE' });
  } finally { f.close(); }
});
