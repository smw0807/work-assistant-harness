import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import git from 'isomorphic-git';
import { CompanyReadonlyRepositoryAdapter } from '../src/adapters/company-readonly-repository.js';
import { collectPersonalCollectionEvidence, inspectPersonalCollectionRepository } from '../src/adapters/personal-readonly-collection-repository.js';
import type { CompanyReadonlyPayload, CompanyReadonlyPolicy, CompanyReadonlyRegistration } from '../src/domain/company-readonly.js';
import type { PersonalCollectionRegistration } from '../src/domain/personal-readonly-collection.js';
import { derivePersonalSourceView, getPersonalCollectionProfile, getPersonalCollectionProfileHash } from '../src/policy/personal-readonly-collection.js';
import { canonicalReadonlyJson, hashReadonlyValue, READONLY_LIMITS } from '../src/policy/readonly-investigation-policy.js';

const author = { name: 'Synthetic Company Reader', email: 'company-reader@example.invalid', timestamp: 1704067200, timezoneOffset: 0 };
const body = 'export const answer = 42;\n// Evidence only; never execute target code.\n';
const policy: CompanyReadonlyPolicy = { version: 'company-readonly-policy-v1', enabled: false,
  readPermission: 'confirmed', storagePermission: 'confirmed', policyReference: 'synthetic-policy', payloadRetentionHours: 24, auditRetentionDays: 30 };
const adapter = new CompanyReadonlyRepositoryAdapter();
const hash = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));
const setup = async (context: TestContext, files: Record<string, string | Buffer> = { 'src/service.ts': body }) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-readonly-source-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true }); fs.writeFileSync(join(root, path), content);
  }
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  for (const filepath of Object.keys(files)) await git.add({ fs, dir: root, filepath });
  const baseCommit = await git.commit({ fs, dir: root, author, committer: author, message: 'Synthetic company source fixture' });
  const paths = Object.keys(files).sort();
  const registration: CompanyReadonlyRegistration = { version: 'company-readonly-registration-v1', repoId: 'company-test',
    sourceRoot: root, baseCommit, question: 'Explain only the selected safe evidence and uncertainty.',
    readRanges: paths.map((path) => ({ path, startLine: 1, endLine: 1 })), reviewPaths: paths };
  return { root, registration };
};
const snapshot = (root: string): string => {
  const entries: unknown[] = [];
  const visit = (path: string): void => {
    const stat = fs.lstatSync(path);
    entries.push({ path: path.slice(root.length), mode: stat.mode, inode: stat.ino, links: stat.nlink, size: stat.size,
      modified: stat.mtimeMs, changed: stat.ctimeMs, hash: stat.isFile() ? hashReadonlyValue(fs.readFileSync(path)) : '' });
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); return canonicalReadonlyJson(entries);
};
const prepare = async (registration: CompanyReadonlyRegistration): Promise<CompanyReadonlyPayload> => {
  const repository = await adapter.inspect(registration, randomUUID());
  return { registration, policy, repository, collected: await adapter.collect(repository, registration), reviewInput: 'Synthetic local review only.' };
};
const legacyRegistration = (registration: CompanyReadonlyRegistration): PersonalCollectionRegistration => ({
  version: 'personal-readonly-registration-v2', collectionPolicy: 'personal-readonly-collection-v2', repoId: registration.repoId,
  sourceRoot: registration.sourceRoot, baseCommit: registration.baseCommit, question: registration.question,
  readRanges: registration.readRanges, transferPaths: registration.reviewPaths,
});

test('company source keeps company identity while reusing the exact safe evidence and leaving source/Git unchanged', async (context) => {
  const { root, registration } = await setup(context);
  const before = snapshot(root), id = randomUUID();
  const repository = await adapter.inspect(registration, id);
  const legacy = await inspectPersonalCollectionRepository(legacyRegistration(registration), id);
  assert.equal(repository.kind, 'company-git'); assert.notEqual(repository.identityHash, legacy.identityHash);
  const { identityHash, ...identity } = repository;
  assert.equal(identityHash, hash(identity));
  assert.deepEqual({ ...repository, kind: 'personal-git', identityHash: legacy.identityHash }, legacy);
  const collected = await adapter.collect(repository, registration);
  assert.deepEqual(collected, await collectPersonalCollectionEvidence(legacy, legacyRegistration(registration)));
  assert.equal(collected.evidence[0]?.excerpt, body.split('\n')[0]);
  adapter.assertUnchanged({ registration, repository, policy, collected, reviewInput: 'Synthetic local review only.' });
  assert.equal(snapshot(root), before);
});

test('company source masks synthetic sensitive content and preserves the existing collection profile and limits', async (context) => {
  const large = 'export const value = 42;\n' + '// safe padding\n'.repeat(2700);
  const secret = 'const token = "SYNTHETIC_PRIVATE_VALUE_A";\nexport const value = 42;\n';
  const { root, registration } = await setup(context, { 'src/large.ts': large, 'src/client.ts': secret });
  const before = snapshot(root), profile = getPersonalCollectionProfile(), profileHash = getPersonalCollectionProfileHash();
  assert.ok(Buffer.byteLength(large) > 32768 && Buffer.byteLength(large) < 65536);
  const payload = await prepare(registration), proof = payload.collected.sourceViews.find((entry) => entry.path === 'src/client.ts')!;
  assert.equal(proof.rawSensitiveCheck, 'rejected'); assert.equal(proof.viewSensitiveCheck, 'passed');
  assert.equal(Object.hasOwn(proof, 'bytes'), false); assert.notEqual(proof.sourceHash, proof.viewHash);
  assert.equal(payload.collected.evidence.find((entry) => entry.path === proof.path)?.fileHash, proof.viewHash);
  assert.equal(JSON.stringify(payload.collected).includes('SYNTHETIC_PRIVATE_VALUE_A'), false);
  adapter.assertUnchanged(payload); assert.equal(snapshot(root), before);
  assert.deepEqual(getPersonalCollectionProfile(), profile); assert.equal(getPersonalCollectionProfileHash(), profileHash);
  assert.deepEqual(profile.limits, { sourceFileBytes: 65536, fullViewBytes: 65536, excerptBytes: 32768,
    evidenceBytes: 65536, inputBytes: 131072, files: 8, ranges: 16, linesPerRange: 200, masks: 128 });
  assert.equal(READONLY_LIMITS.fileBytes, 32768); assert.equal(profileHash, hash(profile));
});

test('company source rejects raw changes even when safe-view content stays identical', async (context) => {
  const first = 'const token = "SYNTHETIC_PRIVATE_VALUE_A";\nexport const value = 42;\n', second = first.replace('VALUE_A', 'VALUE_B');
  assert.equal(derivePersonalSourceView('src/service.ts', Buffer.from(first)).viewHash,
    derivePersonalSourceView('src/service.ts', Buffer.from(second)).viewHash);
  const { root, registration } = await setup(context, { 'src/service.ts': first });
  const payload = await prepare(registration); adapter.assertUnchanged(payload);
  fs.writeFileSync(join(root, 'src/service.ts'), second);
  assert.throws(() => adapter.assertUnchanged(payload), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  await assert.rejects(adapter.collect(payload.repository, registration), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
});

test('company source rejects selected dirty/staged files and Git observation changes using fixed errors', async (context) => {
  for (const kind of ['dirty', 'staged', 'HEAD', 'index']) {
    const { root, registration } = await setup(context), payload = await prepare(registration);
    if (kind === 'dirty' || kind === 'staged') {
      fs.writeFileSync(join(root, 'src/service.ts'), body.replace('42', '43'));
      if (kind === 'staged') {
        await git.add({ fs, dir: root, filepath: 'src/service.ts' }); fs.writeFileSync(join(root, 'src/service.ts'), body);
      }
      await assert.rejects(adapter.inspect(registration, randomUUID()), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
    }
    if (kind === 'HEAD') fs.writeFileSync(join(root, '.git/HEAD'), `${registration.baseCommit}\n`);
    if (kind === 'index') fs.appendFileSync(join(root, '.git/index'), 'X');
    assert.throws(() => adapter.assertUnchanged(payload), (error) => {
      assert.equal((error as { code: string }).code, 'COMPANY_READONLY_SOURCE_CHANGED');
      assert.equal(String(error).includes(root), false); assert.equal(String(error).includes(body), false); return true;
    });
  }
});

test('company source retains file/parent symlink, hardlink and Git worktree indirection rejection', async (context) => {
  for (const kind of ['file-symlink', 'parent-symlink', 'hardlink', 'gitfile']) {
    const { root, registration } = await setup(context), selected = join(root, 'src/service.ts');
    if (kind === 'file-symlink') { fs.renameSync(selected, join(root, 'outside.ts')); fs.symlinkSync('../outside.ts', selected); }
    if (kind === 'parent-symlink') { fs.renameSync(join(root, 'src'), join(root, 'outside')); fs.symlinkSync('outside', join(root, 'src')); }
    if (kind === 'hardlink') fs.linkSync(selected, join(root, 'linked-copy'));
    if (kind === 'gitfile') { fs.renameSync(join(root, '.git'), join(root, 'actual-git')); fs.writeFileSync(join(root, '.git'), 'gitdir: actual-git\n'); }
    await assert.rejects(adapter.inspect(registration, randomUUID()), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  }
});

test('company registration rejects path escape and forged data before opening any source', async (context) => {
  const { registration } = await setup(context); let opens = 0, observations = 0, getters = 0;
  const original = fs.openSync, originalLstat = fs.lstatSync;
  fs.openSync = ((...args) => { opens++; return Reflect.apply(original, fs, args); }) as typeof fs.openSync;
  fs.lstatSync = ((...args) => { observations++; return Reflect.apply(originalLstat, fs, args); }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try {
    for (const path of ['../escape.ts', '/synthetic/outside.ts', 'src/../service.ts', '.env', '.git/config', 'src\\escape.ts']) {
      await assert.rejects(adapter.inspect({ ...registration, readRanges: [{ path, startLine: 1, endLine: 1 }], reviewPaths: [path] }, randomUUID()),
        { code: 'COMPANY_READONLY_INVALID_REGISTRATION' });
    }
    const accessor = { ...registration };
    Object.defineProperty(accessor, 'question', { enumerable: true, get: () => { getters++; return 'must not run'; } });
    await assert.rejects(adapter.inspect(accessor, randomUUID()), { code: 'COMPANY_READONLY_INVALID_REGISTRATION' });
    await assert.rejects(adapter.inspect({ ...registration, reviewPaths: ['unselected.ts'] }, randomUUID()),
      { code: 'COMPANY_READONLY_INVALID_REGISTRATION' });
    assert.equal(opens, 0); assert.equal(observations, 0); assert.equal(getters, 0);
  } finally { fs.openSync = original; fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
});

test('company source rejects forged company identity, evidence and source proofs without invoking getters', async (context) => {
  const { registration } = await setup(context), payload = await prepare(registration);
  await assert.rejects(adapter.collect({ ...payload.repository, identityHash: 'a'.repeat(64) }, registration),
    { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  for (const change of ['identity', 'evidence', 'proof']) {
    const altered = structuredClone(payload);
    if (change === 'identity') altered.repository.kind = 'personal-git' as typeof altered.repository.kind;
    if (change === 'evidence') altered.collected.evidence[0]!.excerpt = 'fabricated safe evidence';
    if (change === 'proof') altered.collected.sourceViews[0]!.maskCount++;
    assert.throws(() => adapter.assertUnchanged(altered), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  }
  let getters = 0;
  const altered = Object.defineProperty({ ...payload }, 'collected', { enumerable: true, get() { getters++; return payload.collected; } });
  assert.throws(() => adapter.assertUnchanged(altered), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  assert.equal(getters, 0);
});

test('company source retains the existing source, excerpt and total-evidence bounds', async (context) => {
  const oversized = await setup(context, { 'large.ts': 'a'.repeat(65537) });
  await assert.rejects(adapter.inspect(oversized.registration, randomUUID()), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  const excerpt = await setup(context, { 'line.ts': 'a'.repeat(32769) + '\n' });
  await assert.rejects(adapter.inspect(excerpt.registration, randomUUID()), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  const total = await setup(context, { 'a.ts': 'a'.repeat(24576), 'b.ts': 'b'.repeat(24576), 'c.ts': 'c'.repeat(24576) });
  const totalRepository = await adapter.inspect(total.registration, randomUUID());
  await assert.rejects(adapter.collect(totalRepository, total.registration), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
});
