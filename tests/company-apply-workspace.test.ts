import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import type { CompanyApplyRegistration } from '../src/domain/company-apply.js';
import { CompanyApplyWorkspace, deriveCompanyApplyMutationPaths, inspectCompanyApplySource } from '../src/adapters/company-apply-workspace.js';
import { createSyntheticCompanyChangeWorkspace, SYNTHETIC_COMPANY_CHANGE_FILES } from '../src/adapters/synthetic-company-change-workspace.js';
import { hashCompanyApplyValue } from '../src/policy/company-apply.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const fixture = async () => {
  const parent = fs.mkdtempSync('/private/tmp/harness-company-write-source-'), synthetic = await createSyntheticCompanyChangeWorkspace(parent);
  const root = synthetic.repositoryRoot;
  fs.writeFileSync(join(root, '.git/packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${synthetic.baseCommit} refs/heads/main\n${synthetic.baseCommit} refs/heads/old-branch\n`, { mode: 0o600 });
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: 'generic-synthetic', requestRevision: 1,
    objective: 'Apply declared synthetic source bytes', baseBranch: 'main', baseCommit: synthetic.baseCommit,
    baseIndexHash: synthetic.baseIndexHash, workType: 'feature', branch: 'feature/declared-source', changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyApplyValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!), content: "export const message = 'declared after';\n" },
      { operation: 'replace', path: 'src/options.ts', beforeHash: hashCompanyApplyValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!), content: 'export const options = { enabled: true };\n' },
      { operation: 'create', path: 'src/created.ts', beforeHash: null, content: 'export const created = true;\n' },
    ] };
  const registration: CompanyApplyRegistration = { version: 'company-write-registration-v1', repoId: draft.repoId, sourceRoot: root,
    baseBranch: draft.baseBranch, baseCommit: draft.baseCommit, baseIndexHash: draft.baseIndexHash,
    writeAllowedFiles: draft.changes.map(change => change.path), enabled: true, localRead: 'allowed', localWrite: 'allowed' };
  const paths = deriveCompanyApplyMutationPaths(registration, draft, taskId);
  return { parent, root, registration, draft, paths,
    read: (path: string) => fs.readFileSync(join(root, path), 'utf8'),
    write: (path: string, value: string) => fs.writeFileSync(join(root, path), value, { mode: 0o600 }),
    close: () => fs.rmSync(parent, { recursive: true, force: true }) };
};
const prepared = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const { source } = await inspectCompanyApplySource(f.registration, f.draft), workspace = new CompanyApplyWorkspace(f.registration, f.draft, taskId);
  await workspace.prepare(source); return { source, workspace };
};
const mainHead = 'ref: refs/heads/main\n';

test('packed refs coexist with a loose base and mixed file application preserves packed/index/base and unrelated edits', async () => {
  const f = await fixture();
  try {
    f.write('README.md', 'Existing user work\n'); fs.chmodSync(join(f.root, 'src/message.ts'), 0o640);
    const packed = f.read('.git/packed-refs'), index = fs.readFileSync(f.paths.index), base = f.read('.git/refs/heads/main');
    const { source, workspace } = await prepared(f);
    try {
      assert.equal(source.baseRefKind, 'loose'); assert.equal(source.packedRefsHash, hashCompanyApplyValue(packed));
      assert.equal(f.read('.git/HEAD'), mainHead);
      await workspace.createBranch();
      assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
      assert.equal(f.read('src/message.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']);
      for (let index = 0; index < f.draft.changes.length; index++) await workspace.writeFile(index);
      await workspace.verifyApplied();
      for (const change of f.draft.changes) assert.equal(f.read(change.path), change.content);
      assert.equal(fs.statSync(join(f.root, 'src/message.ts')).mode & 0o777, 0o640);
      assert.equal(f.read('README.md'), 'Existing user work\n'); assert.equal(f.read('.git/packed-refs'), packed);
      assert.deepEqual(fs.readFileSync(f.paths.index), index); assert.equal(f.read('.git/refs/heads/main'), base);
    } finally { await workspace.close(); }
    assert.equal(fs.existsSync(f.paths.packedRefsLock), false);
    assert.equal(f.paths.writePaths.includes(join(f.root, '.git/packed-refs')), false);
  } finally { f.close(); }
});

test('a packed-only flat base remains packed while the new loose branch is created', async () => {
  const f = await fixture();
  try {
    fs.unlinkSync(f.paths.baseRef);
    const { source, workspace } = await prepared(f);
    try {
      assert.equal(source.baseRefKind, 'packed'); await workspace.createBranch();
      for (let index = 0; index < f.draft.changes.length; index++) await workspace.writeFile(index);
      await workspace.verifyApplied();
      assert.equal(fs.existsSync(f.paths.baseRef), false);
      assert.equal(f.read(`.git/refs/heads/${f.draft.branch}`), `${f.registration.baseCommit}\n`);
    } finally { await workspace.close(); }
  } finally { f.close(); }
});

test('packed reference changes, appearance or disappearance invalidate a prepared source before branch mutation', async () => {
  for (const variant of ['change', 'remove', 'appear'] as const) {
    const f = await fixture();
    try {
      if (variant === 'appear') fs.unlinkSync(join(f.root, '.git/packed-refs'));
      const { workspace } = await prepared(f);
      try {
        if (variant === 'remove') fs.unlinkSync(join(f.root, '.git/packed-refs'));
        else f.write('.git/packed-refs', `${f.registration.baseCommit} refs/heads/another\n`);
        await assert.rejects(workspace.createBranch(), { code: 'COMPANY_APPLY_SOURCE_CHANGED' });
        assert.equal(f.read('.git/HEAD'), mainHead); assert.equal(fs.existsSync(f.paths.branchRef), false);
      } finally { await workspace.close(); }
    } finally { f.close(); }
  }
});

test('matching draft hashes do not permit selected working changes or staged differences from the baseline commit', async () => {
  const f = await fixture();
  try {
    f.write('src/message.ts', '// Existing selected user edit\n');
    f.draft.changes[0]!.beforeHash = hashCompanyApplyValue(f.read('src/message.ts'));
    await assert.rejects(inspectCompanyApplySource(f.registration, f.draft));
    assert.equal(f.read('.git/HEAD'), mainHead); assert.equal(f.read('src/message.ts'), '// Existing selected user edit\n');
  } finally { f.close(); }
});

test('a second-file conflict preserves the first file and new branch without changing packed refs or index', async () => {
  const f = await fixture();
  try {
    const { workspace } = await prepared(f), packed = f.read('.git/packed-refs'), index = fs.readFileSync(f.paths.index);
    try {
      await workspace.createBranch(); await workspace.writeFile(0);
      f.write('src/options.ts', '// Concurrent user work\n');
      await assert.rejects(workspace.writeFile(1), { code: 'COMPANY_APPLY_SOURCE_CHANGED' });
      assert.equal(f.read('src/message.ts'), f.draft.changes[0]!.content);
      assert.equal(f.read('src/options.ts'), '// Concurrent user work\n');
      assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
      assert.equal(fs.existsSync(join(f.root, 'src/created.ts')), false);
      assert.equal(f.read('.git/packed-refs'), packed); assert.deepEqual(fs.readFileSync(f.paths.index), index);
    } finally { await workspace.close(); }
  } finally { f.close(); }
});

test('existing packed branch names and their case/prefix aliases cannot be shadowed by a new loose ref', async () => {
  for (const name of ['feature/declared-source', 'feature/DECLARED-source', 'feature', 'feature/declared-source/child']) {
    const f = await fixture();
    try {
      f.write('.git/packed-refs', `${f.registration.baseCommit} refs/heads/${name}\n`);
      await assert.rejects(inspectCompanyApplySource(f.registration, f.draft), { code: 'COMPANY_APPLY_BRANCH_CONFLICT' });
      assert.equal(f.read('.git/HEAD'), mainHead); assert.equal(fs.existsSync(f.paths.branchRef), false);
    } finally { f.close(); }
  }
});
