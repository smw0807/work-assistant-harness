import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSyntheticCompanyChangeWorkspace, SYNTHETIC_COMPANY_CHANGE_FILES } from '../src/adapters/synthetic-company-change-workspace.js';
import { CompanyApplyWorkspace, inspectCompanyApplySource } from '../src/adapters/company-apply-workspace.js';
import { claimCompanyApply, CompanyApplyJournal, observeCompanyApplyJournal, readCompanyApplyClaim } from '../src/adapters/company-apply-journal.js';
import { applyClaimedCompanyApply } from '../src/application/apply-company-apply.js';
import { createCompanyApplyApproval, createCompanyApplyPlan, hashCompanyApplyValue } from '../src/policy/company-apply.js';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import type { CompanyApplyRegistration } from '../src/domain/company-apply.js';

const context = () => ({ ownerId: `os-user:${process.getuid!()}`, now: new Date() });
const fixture = async () => {
  const root = fs.mkdtempSync('/private/tmp/harness-write-execution-'); fs.chmodSync(root, 0o700);
  const workspace = await createSyntheticCompanyChangeWorkspace(root), directory = join(root, 'execution');
  fs.mkdirSync(directory, { mode: 0o700 });
  const registration: CompanyApplyRegistration = { version: 'company-write-registration-v1', repoId: 'synthetic-company-change',
    sourceRoot: workspace.repositoryRoot, baseBranch: 'main', baseCommit: workspace.baseCommit, baseIndexHash: workspace.baseIndexHash,
    writeAllowedFiles: ['src/message.ts', 'src/options.ts', 'src/added.ts'], enabled: true, localRead: 'allowed', localWrite: 'allowed' };
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: registration.repoId, requestRevision: 1,
    objective: 'Synthetic durable write validation', baseCommit: registration.baseCommit, baseBranch: 'main',
    baseIndexHash: registration.baseIndexHash, workType: 'feature', branch: 'feature/durable-write', changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyApplyValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!), content: "export const message = 'changed';\n" },
      { operation: 'replace', path: 'src/options.ts', beforeHash: hashCompanyApplyValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!), content: 'export const options = { changed: true };\n' },
      { operation: 'create', path: 'src/added.ts', beforeHash: null, content: 'export const added = true;\n' },
    ] };
  const { source } = await inspectCompanyApplySource(registration, draft);
  const { plan } = createCompanyApplyPlan(draft, registration, source, context());
  const approval = createCompanyApplyApproval(plan, { taskId: plan.id, planHash: plan.planHash, expiresInMinutes: 1 }, context());
  return { root, workspace, directory, registration, draft, plan, approval,
    read: (path: string) => fs.readFileSync(join(workspace.repositoryRoot, path), 'utf8'),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test('write approval is consumed durably once; caller mutation and copied storage do not replace the claim', async () => {
  const f = await fixture();
  try {
    const originalHash = f.plan.planHash, pending = claimCompanyApply(f.directory, f.plan, f.approval);
    f.plan.branch = 'feature/changed-after-call'; await pending;
    const claim = await readCompanyApplyClaim(f.directory);
    assert.equal(claim.plan.planHash, originalHash); assert.equal(claim.plan.branch, 'feature/durable-write');
    assert.notEqual(claim.approval.usedAt, null);
    await assert.rejects(claimCompanyApply(f.directory, claim.plan, f.approval), { code: 'EEXIST' });
    const copy = join(f.root, 'copied'); fs.cpSync(f.directory, copy, { recursive: true }); fs.chmodSync(copy, 0o700);
    await assert.rejects(readCompanyApplyClaim(copy), { code: 'COMPANY_APPLY_INVALID_CLAIM' });
    assert.equal(f.read('.git/HEAD'), 'ref: refs/heads/main\n');
    assert.equal(fs.statSync(join(f.directory, 'claim.json')).mode & 0o777, 0o600);
    const body = fs.readFileSync(join(f.directory, 'claim.json'), 'utf8');
    assert.equal(body.includes(f.draft.changes[0]!.content), false);
    assert.equal(body.includes(f.registration.sourceRoot), false);
  } finally { f.close(); }
});

test('expired, wrong-owner, pre-used or changed approvals fail before a claim file is created', async () => {
  const f = await fixture();
  try {
    for (const variant of ['expired', 'owner', 'used', 'hash'] as const) {
      const approval = structuredClone(f.approval);
      if (variant === 'owner') approval.ownerId = 'os-user:999999';
      if (variant === 'used') approval.usedAt = approval.createdAt;
      if (variant === 'hash') approval.planHash = 'a'.repeat(64);
      await assert.rejects(claimCompanyApply(f.directory, f.plan, approval,
        variant === 'expired' ? new Date(approval.expiresAt) : new Date()));
      assert.deepEqual(fs.readdirSync(f.directory), []);
    }
  } finally { f.close(); }
});

test('journal append order, hash, private permissions and partial tails fail closed', async () => {
  const f = await fixture();
  try {
    await claimCompanyApply(f.directory, f.plan, f.approval);
    const journal = await CompanyApplyJournal.open(f.directory);
    try {
      await journal.record('branch', null, 'INTENT');
      await assert.rejects(journal.record('file', 'src/message.ts', 'DONE'), { code: 'COMPANY_APPLY_INVALID_JOURNAL' });
      await assert.rejects(journal.record('branch', null, 'DONE'), { code: 'COMPANY_APPLY_JOURNAL_UNAVAILABLE' });
    } finally { await journal.close(); }
    const file = join(f.directory, 'journal.jsonl'), original = fs.readFileSync(file);
    assert.equal((await observeCompanyApplyJournal(f.directory)).status, 'INTERRUPTED');
    fs.appendFileSync(file, '{');
    await assert.rejects(observeCompanyApplyJournal(f.directory), { code: 'COMPANY_APPLY_INCOMPLETE_JOURNAL' });
    fs.writeFileSync(file, original.toString().replace('INTENT', 'DONE'));
    await assert.rejects(observeCompanyApplyJournal(f.directory), { code: 'COMPANY_APPLY_INVALID_JOURNAL' });
    fs.writeFileSync(file, original); fs.chmodSync(file, 0o644);
    await assert.rejects(observeCompanyApplyJournal(f.directory), { code: 'COMPANY_APPLY_UNSAFE_STORAGE' });
  } finally { f.close(); }
});

test('journal cannot adopt a replaced inode or a second writer after an interrupted attempt', async () => {
  const f = await fixture();
  try {
    await claimCompanyApply(f.directory, f.plan, f.approval);
    const journal = await CompanyApplyJournal.open(f.directory), file = join(f.directory, 'journal.jsonl');
    try {
      fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, '', { mode: 0o600 });
      await assert.rejects(journal.record('branch', null, 'INTENT'), { code: 'COMPANY_APPLY_STORAGE_CHANGED' });
      assert.equal(fs.readFileSync(file, 'utf8'), '');
    } finally { await journal.close(); }
    await assert.rejects(CompanyApplyJournal.open(f.directory), { code: 'EEXIST' });
  } finally { f.close(); }
});

test('branch-first execution records each boundary, preserves index/base/unselected dirt and refuses replay', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(join(f.workspace.repositoryRoot, 'README.md'), 'Synthetic user work\n');
    await claimCompanyApply(f.directory, f.plan, f.approval);
    const result = await applyClaimedCompanyApply(f.registration, f.draft, f.directory);
    assert.equal(result.status, 'APPLIED'); assert.equal(result.journal.length, 9);
    assert.deepEqual(result.journal.slice(0, 2).map(entry => [entry.kind, entry.state]), [['branch', 'INTENT'], ['branch', 'DONE']]);
    assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
    for (const change of f.draft.changes) assert.equal(f.read(change.path), change.content);
    assert.equal(f.read('README.md'), 'Synthetic user work\n');
    assert.equal(hashCompanyApplyValue(fs.readFileSync(join(f.workspace.repositoryRoot, '.git/index'))), f.registration.baseIndexHash);
    assert.equal(f.read('.git/refs/heads/main'), `${f.registration.baseCommit}\n`);
    await assert.rejects(applyClaimedCompanyApply(f.registration, f.draft, f.directory));
    assert.deepEqual(await observeCompanyApplyJournal(f.directory), result);
  } finally { f.close(); }
});

test('source drift and expiration between durable boundaries stop further mutation without rollback', async () => {
  for (const mode of ['drift', 'expiry'] as const) {
    const f = await fixture();
    try {
      await claimCompanyApply(f.directory, f.plan, f.approval);
      let now = new Date();
      const result = await applyClaimedCompanyApply(f.registration, f.draft, f.directory, (registration, draft, id) => {
        const workspace = new CompanyApplyWorkspace(registration, draft, id);
        return { prepare: source => workspace.prepare(source), createBranch: () => workspace.createBranch(),
          writeFile: async index => {
            await workspace.writeFile(index);
            if (index === 0) {
              if (mode === 'drift') fs.appendFileSync(join(registration.sourceRoot, 'src/options.ts'), '// User edit\n');
              else now = new Date(f.approval.expiresAt);
            }
          }, verifyApplied: () => workspace.verifyApplied(), close: () => workspace.close() };
      }, () => now);
      assert.equal(result.status, 'FAILED');
      assert.equal(f.read('src/message.ts'), f.draft.changes[0]!.content);
      assert.equal(f.read('src/options.ts').startsWith(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!), true);
      assert.equal(fs.existsSync(join(f.workspace.repositoryRoot, 'src/added.ts')), false);
      assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
      await assert.rejects(applyClaimedCompanyApply(f.registration, f.draft, f.directory));
    } finally { f.close(); }
  }
});

test('SIGKILL after an uncertain file boundary retains the actual file, locks, INTENT and consumed approval', { timeout: 15_000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await claimCompanyApply(f.directory, f.plan, f.approval);
    const application = pathToFileURL(join(process.cwd(), 'dist/src/application/apply-company-apply.js')).href;
    const workspace = pathToFileURL(join(process.cwd(), 'dist/src/adapters/company-apply-workspace.js')).href;
    const script = `import {applyClaimedCompanyApply} from ${JSON.stringify(application)};
import {CompanyApplyWorkspace} from ${JSON.stringify(workspace)};
const input=JSON.parse(process.argv[1]);
await applyClaimedCompanyApply(input.registration,input.draft,input.directory,(registration,draft,id)=>{
 const workspace=new CompanyApplyWorkspace(registration,draft,id);
 return {prepare:s=>workspace.prepare(s),createBranch:()=>workspace.createBranch(),
 writeFile:async index=>{await workspace.writeFile(index);if(index===0){process.send('boundary');await new Promise(()=>{});}},
 verifyApplied:()=>workspace.verifyApplied(),close:()=>workspace.close()};
});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ registration: f.registration, draft: f.draft, directory: f.directory })],
      { env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const boundary = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Child exited before boundary'); })]);
    assert.equal(boundary[0], 'boundary'); const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    const observed = await observeCompanyApplyJournal(f.directory);
    assert.equal(observed.status, 'INTERRUPTED'); assert.equal(observed.approvalConsumed, true);
    assert.equal(observed.journal.at(-1)!.state, 'INTENT'); assert.equal(observed.journal.at(-1)!.path, 'src/message.ts');
    assert.equal(f.read('src/message.ts'), f.draft.changes[0]!.content);
    assert.equal(f.read('src/options.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']);
    assert.equal(fs.existsSync(join(f.workspace.repositoryRoot, '.git/index.lock')), true);
    await assert.rejects(applyClaimedCompanyApply(f.registration, f.draft, f.directory));
    assert.deepEqual(await observeCompanyApplyJournal(f.directory), observed);
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); f.close(); }
});
