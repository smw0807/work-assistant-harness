import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import type { CompanyApplyRegistration } from '../src/domain/company-apply.js';
import { inspectCompanyApplyGit } from '../src/adapters/company-apply-git.js';
import { createCompanyGitRangeApplySource, createCompanyGitRangeUnitSource } from '../src/adapters/company-git-range-unit-source.js';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { COMPANY_APPLY_PACKED_REFS_MAX_BYTES, parseCompanyApplyPackedRefs } from '../src/policy/company-apply-packed-refs.js';
import { hashCompanyApplyValue } from '../src/policy/company-apply.js';
import { createCompanyGitRangeFixture } from './company-readonly-git-range-fixture.js';

const fixture = async (context: TestContext, layout: 'pack' | 'pack-ref' | 'loose' = 'loose') => {
  const f = await createCompanyGitRangeFixture(context, layout);
  fs.writeFileSync(join(f.root, '.git/HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(join(f.root, '.git/refs/heads/main'), `${f.baseCommit}\n`, { mode: 0o600 });
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: 'company-apply-synthetic', requestRevision: 1,
    objective: 'Preserve selected synthetic local edits', baseCommit: f.baseCommit, baseBranch: 'main',
    baseIndexHash: hashCompanyApplyValue(fs.readFileSync(join(f.root, '.git/index'))), workType: 'feature', branch: 'feature/git-proof',
    changes: [
      { operation: 'replace', path: 'src/main.ts', beforeHash: hashCompanyApplyValue(f.selectedFiles['src/main.ts']!), content: 'export const value = 43;\n' },
      { operation: 'create', path: 'src/new.ts', beforeHash: null, content: 'export const newValue = 1;\n' },
    ] };
  const registration: CompanyApplyRegistration = { version: 'company-write-registration-v1', repoId: draft.repoId,
    sourceRoot: f.root, baseBranch: draft.baseBranch, baseCommit: draft.baseCommit, baseIndexHash: draft.baseIndexHash,
    writeAllowedFiles: draft.changes.map(change => change.path), enabled: true, localRead: 'allowed', localWrite: 'allowed' };
  return { ...f, draft, registration };
};
const input = (f: Awaited<ReturnType<typeof fixture>>) => ({ version: 'company-git-range-apply-source-v1',
  profileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(),
  sourceRoot: f.root, baseCommit: f.baseCommit, baseBranch: 'main', targetBranch: f.draft.branch,
  selectedPaths: f.draft.changes.filter(change => change.operation === 'replace').map(change => change.path),
  absentPaths: f.draft.changes.filter(change => change.operation === 'create').map(change => change.path) });
const createOnly = (f: Awaited<ReturnType<typeof fixture>>, path = 'src/new.ts'): void => {
  f.draft.changes = [{ operation: 'create', path, beforeHash: null, content: 'export const added = true;\n' }];
  f.registration.writeAllowedFiles = [path];
};
const indexBytes = (entries: Array<{ path: string; oid?: string; mode?: string; stage?: number }>): Buffer => {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const records = entries.map(item => {
    const name = Buffer.from(item.path), size = Math.ceil((62 + name.length + 1) / 8) * 8, bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(parseInt(item.mode ?? '100644', 8), 24); Buffer.from(item.oid ?? '1'.repeat(40), 'hex').copy(bytes, 40);
    bytes.writeUInt16BE(((item.stage ?? 0) << 12) | Math.min(name.length, 0xfff), 60); name.copy(bytes, 62); return bytes;
  });
  const body = Buffer.concat([header, ...records]); return Buffer.concat([body, createHash('sha1').update(body).digest()]);
};
const setIndex = (f: Awaited<ReturnType<typeof fixture>>, bytes: Buffer): void => {
  fs.writeFileSync(join(f.root, '.git/index'), bytes);
  f.draft.baseIndexHash = hashCompanyApplyValue(bytes); f.registration.baseIndexHash = f.draft.baseIndexHash;
};

test('mixed Git proof freshly verifies loose, OFS and REF chains plus create absence without exposing bodies or mutating the fixture', async context => {
  for (const layout of ['loose', 'pack', 'pack-ref'] as const) {
    const f = await fixture(context, layout), before = f.snapshot(), source = createCompanyGitRangeApplySource(input(f), () => 0);
    try {
      const first = source.inspect(), second = source.verify();
      assert.deepEqual(first, second); assert.equal(first.version, 'company-git-range-apply-observation-v1');
      assert.deepEqual(first.selectedFiles.map(file => file.path), ['src/main.ts']); assert.deepEqual(first.absentPaths, ['src/new.ts']);
      assert.ok(first.fileSystem.absentPaths.includes('src/new.ts')); assert.equal(first.workingIndexHash, f.draft.baseIndexHash);
      assert.equal(first.baseRefKind, 'loose'); assert.equal(first.packedRefsHash, null);
      assert.equal(source.snapshot().completedPasses, 2); assert.equal(source.snapshot().openDescriptors, 0); assert.equal(source.snapshot().liveMemoryBytes, 0);
      assert.equal(JSON.stringify(first).includes(f.selectedFiles['src/main.ts']!), false);
      assert.equal(JSON.stringify(first).includes('Synthetic historical source'), false);
      const proof = await inspectCompanyApplyGit(f.registration, f.draft);
      assert.equal(proof.proofHash, first.proofHash); assert.equal(proof.baseRefKind, 'loose');
      assert.ok(proof.metadataPaths.includes(join(f.root, 'src/new.ts')));
      assert.equal(proof.readPaths.includes(join(f.root, 'src/new.ts')), false);
      assert.equal(proof.readPaths.includes(join(f.root, 'README.md')), false);
      assert.ok(proof.readDirectories.includes(join(f.root, '.git/objects/pack')));
      assert.ok(proof.readPaths.length <= 128 && proof.metadataPaths.length <= 128);
      assert.equal(f.snapshot(), before);
    } finally { source.close(); }
  }
});

test('all-create plans prove HEAD, index and working absence, including a missing HEAD tree prefix with an existing local parent', async context => {
  const f = await fixture(context); fs.mkdirSync(join(f.root, 'untracked-parent'), { mode: 0o700 }); createOnly(f, 'untracked-parent/added.ts');
  const source = createCompanyGitRangeApplySource(input(f), () => 0);
  try {
    const first = source.inspect(); assert.deepEqual(first.selectedFiles, []); assert.deepEqual(first.absentPaths, ['untracked-parent/added.ts']);
    assert.equal(source.verify().proofHash, first.proofHash); assert.equal(source.snapshot().completedPasses, 2);
    const proof = await inspectCompanyApplyGit(f.registration, f.draft); assert.equal(proof.proofHash, first.proofHash);
  } finally { source.close(); }
});

test('packed-only base and loose-over-packed base resolution bind the complete packed-refs hash without changing it', async context => {
  for (const packedOnly of [false, true]) {
    const f = await fixture(context), packed = `# pack-refs with: peeled fully-peeled sorted \n${packedOnly ? f.baseCommit : '2'.repeat(40)} refs/heads/main\n${'3'.repeat(40)} refs/tags/synthetic\n^${'4'.repeat(40)}\n`;
    fs.writeFileSync(join(f.root, '.git/packed-refs'), packed, { mode: 0o600 });
    if (packedOnly) fs.unlinkSync(join(f.root, '.git/refs/heads/main'));
    const before = f.snapshot(), proof = await inspectCompanyApplyGit(f.registration, f.draft);
    assert.equal(proof.packedRefsHash, hashCompanyApplyValue(packed)); assert.equal(proof.baseRefKind, packedOnly ? 'packed' : 'loose');
    assert.ok(proof.readPaths.includes(join(f.root, '.git/packed-refs')));
    assert.ok(proof.metadataPaths.includes(join(f.root, '.git/refs/heads/main')));
    assert.equal(f.snapshot(), before);
  }
});

test('packed target refs and case or prefix collisions are rejected before any source mutation', async context => {
  for (const ref of ['refs/heads/feature/git-proof', 'refs/heads/FEATURE/GIT-PROOF', 'refs/heads/feature', 'refs/heads/feature/git-proof/nested']) {
    const f = await fixture(context); fs.writeFileSync(join(f.root, '.git/packed-refs'), `${f.baseCommit} ${ref}\n`, { mode: 0o600 });
    const before = f.snapshot(); await assert.rejects(inspectCompanyApplyGit(f.registration, f.draft)); assert.equal(f.snapshot(), before);
  }
});

test('existing selected working edits or staged changes cannot be turned into clean replacements by updating draft hashes', async context => {
  for (const variant of ['working', 'staged', 'conflict']) {
    const f = await fixture(context);
    if (variant === 'working') {
      fs.writeFileSync(join(f.root, 'src/main.ts'), 'Existing local work\n'); f.draft.changes[0]!.beforeHash = hashCompanyApplyValue('Existing local work\n');
    } else setIndex(f, indexBytes([{ path: 'src/main.ts', oid: variant === 'staged' ? '2'.repeat(40) : f.mainOid, stage: variant === 'conflict' ? 2 : 0 }]));
    const before = f.snapshot(); await assert.rejects(inspectCompanyApplyGit(f.registration, f.draft)); assert.equal(f.snapshot(), before);
  }
});

test('create refuses existing HEAD entries and case aliases even when the selected working file is absent', async context => {
  for (const path of ['src/main.ts', 'SRC/main.ts', 'src/MAIN.ts', 'README.md/child.ts']) {
    const f = await fixture(context); createOnly(f, path);
    if (path === 'src/main.ts') fs.unlinkSync(join(f.root, path));
    await assert.rejects(inspectCompanyApplyGit(f.registration, f.draft));
  }
});

test('create rejects stage-zero, conflict-stage, case, ancestor and descendant index entries', async context => {
  for (const entry of [{ path: 'src/new.ts', stage: 0 }, { path: 'src/new.ts', stage: 2 }, { path: 'SRC/NEW.ts', stage: 3 },
    { path: 'src', mode: '160000' }, { path: 'src/new.ts/child.ts' }]) {
    const f = await fixture(context); createOnly(f); setIndex(f, indexBytes([entry]));
    const before = f.snapshot(); await assert.rejects(inspectCompanyApplyGit(f.registration, f.draft)); assert.equal(f.snapshot(), before);
  }
});

test('create rejects untracked working files without reading their body and absence drift invalidates verification', async context => {
  const f = await fixture(context); createOnly(f);
  const source = createCompanyGitRangeApplySource(input(f), () => 0);
  try {
    source.inspect(); fs.writeFileSync(join(f.root, 'src/new.ts'), 'Untracked local work\n', { mode: 0o600 });
    const actual = fs.readSync; let selectedReads = 0;
    const target = fs.statSync(join(f.root, 'src/new.ts'));
    const mock = context.mock.method(fs, 'readSync', ((fd: number, ...args: unknown[]) => {
      const stat = fs.fstatSync(fd); if (stat.dev === target.dev && stat.ino === target.ino) selectedReads++;
      return Reflect.apply(actual, fs, [fd, ...args]);
    }) as typeof fs.readSync);
    try { assert.throws(() => source.verify()); assert.equal(selectedReads, 0); }
    finally { mock.mock.restore(); }
    assert.equal(fs.readFileSync(join(f.root, 'src/new.ts'), 'utf8'), 'Untracked local work\n');
    assert.equal(source.snapshot().phase, 'failed'); assert.equal(source.snapshot().openDescriptors, 0);
  } finally { source.close(); }
});

test('packed-refs changes between the two passes invalidate the proof even when the active loose base is unchanged', async context => {
  const f = await fixture(context); fs.writeFileSync(join(f.root, '.git/packed-refs'), `${f.baseCommit} refs/heads/main\n`, { mode: 0o600 });
  const source = createCompanyGitRangeApplySource(input(f), () => 0);
  try {
    source.inspect(); fs.appendFileSync(join(f.root, '.git/packed-refs'), `${'2'.repeat(40)} refs/tags/new-tag\n`);
    assert.throws(() => source.verify(), { code: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' });
    assert.equal(source.snapshot().openDescriptors, 0); assert.equal(source.snapshot().liveMemoryBytes, 0);
  } finally { source.close(); }
});

test('packed parser accepts inert comments and one peeled record while rejecting malformed, aliased or oversized references', () => {
  const a = '1'.repeat(40), b = '2'.repeat(40), c = '3'.repeat(40);
  assert.deepEqual(parseCompanyApplyPackedRefs(Buffer.from(`# pack-refs with: peeled fully-peeled sorted \n${a} refs/heads/main\n${b} refs/tags/v1\n^${c}\n`)),
    [{ ref: 'refs/heads/main', oid: a, peeledOid: null }, { ref: 'refs/tags/v1', oid: b, peeledOid: c }]);
  for (const text of [`${a} refs/heads/main`, `^${a}\n`, `${a} refs/tags/v1\n^${b}\n^${c}\n`,
    `${a} refs/heads/main\n${b} refs/heads/MAIN\n`, `${a} refs/heads/a\n${b} refs/heads/a-b\n${c} refs/heads/a/b\n`,
    `${a} refs/heads/../escape\n`, `${a} refs/heads/x.lock\n`, `${a} refs/heads/main\r\n`, '\n',
    `# pack-refs with: invented \n${a} refs/heads/main\n`, `${'0'.repeat(40)} refs/heads/main\n`]) {
    assert.throws(() => parseCompanyApplyPackedRefs(Buffer.from(text)), { code: 'COMPANY_APPLY_INVALID_PACKED_REFS' });
  }
  assert.throws(() => parseCompanyApplyPackedRefs(Buffer.alloc(COMPANY_APPLY_PACKED_REFS_MAX_BYTES + 1)), { code: 'COMPANY_APPLY_INVALID_PACKED_REFS' });
  assert.throws(() => parseCompanyApplyPackedRefs(Buffer.from([0xff, 10])), { code: 'COMPANY_APPLY_INVALID_PACKED_REFS' });
  let evaluated = 0; const malicious = Buffer.from(`${a} refs/heads/main\n`);
  Object.defineProperty(malicious, 'byteLength', { get: () => { evaluated++; return 0; } });
  assert.throws(() => parseCompanyApplyPackedRefs(malicious)); assert.equal(evaluated, 0);
});

test('new mixed request rejects forged selections and cannot enter the unchanged version-two reader', async context => {
  const f = await fixture(context), request = input(f);
  for (const value of [{ ...request, absentPaths: ['src/main.ts'] }, { ...request, selectedPaths: [], absentPaths: [] },
    { ...request, selectedPaths: [], absentPaths: ['src/new', 'src/new-b', 'src/new/child.ts'] },
    { ...request, absentPaths: ['../outside.ts'] }, { ...request, targetBranch: 'main' }]) {
    assert.throws(() => createCompanyGitRangeApplySource(value), { code: 'COMPANY_GIT_RANGE_INVALID_SOURCE_INPUT' });
  }
  assert.throws(() => createCompanyGitRangeUnitSource(request), { code: 'COMPANY_GIT_RANGE_INVALID_SOURCE_INPUT' });
  const legacy = { version: 'company-git-range-source-v2', profileHash: request.profileHash, guardPolicyHash: request.guardPolicyHash,
    sourceRoot: f.root, baseCommit: f.baseCommit, selectedPaths: ['src/main.ts'] };
  const first = createCompanyGitRangeUnitSource(legacy, () => 0), again = createCompanyGitRangeUnitSource(legacy, () => 0);
  try {
    const observed = first.inspect(); first.verify(); const budget = first.snapshot();
    await inspectCompanyApplyGit(f.registration, f.draft);
    assert.deepEqual(again.inspect(), observed); again.verify(); assert.deepEqual(again.snapshot(), budget);
    assert.equal(observed.version, 'company-git-range-source-observation-v2'); assert.equal(Object.hasOwn(observed, 'absentPaths'), false);
  } finally { first.close(); again.close(); }
});

test('apply index bound is conservative and does not reduce the old reader index allowance', async context => {
  const f = await fixture(context), old = fs.readFileSync(join(f.root, '.git/index'));
  const extension = Buffer.alloc(8 + 1_048_576); extension.write('TREE'); extension.writeUInt32BE(1_048_576, 4);
  const body = Buffer.concat([old.subarray(0, -20), extension]), enlarged = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  setIndex(f, enlarged); await assert.rejects(inspectCompanyApplyGit(f.registration, f.draft), { code: 'COMPANY_GIT_RANGE_LIMIT' });
  const source = createCompanyGitRangeUnitSource({ version: 'company-git-range-source-v2', profileHash: getCompanyGitRangeUnitProfileHash(),
    guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), sourceRoot: f.root, baseCommit: f.baseCommit, selectedPaths: ['src/main.ts'] }, () => 0);
  try { source.inspect(); source.verify(); assert.equal(source.snapshot().completedPasses, 2); }
  finally { source.close(); }
});
