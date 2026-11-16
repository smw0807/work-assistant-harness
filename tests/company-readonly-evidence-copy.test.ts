import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { CompanyReadonlyRepositoryAdapter } from '../src/adapters/company-readonly-repository.js';
import type { CompanyReadonlyPolicy, CompanyReadonlyRegistration } from '../src/domain/company-readonly.js';
import { createCompanyReadonlyPreparation, validateCompanyReadonlyPayload } from '../src/policy/company-readonly.js';
import { getPersonalCollectionProfileHash } from '../src/policy/personal-readonly-collection.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyEvidenceCopyFixture } from './company-readonly-evidence-copy-fixture.js';

const adapter = new CompanyReadonlyRepositoryAdapter();
const policy: CompanyReadonlyPolicy = { version: 'company-readonly-policy-v1', enabled: false,
  readPermission: 'confirmed', storagePermission: 'confirmed', policyReference: 'synthetic-copy-test',
  payloadRetentionHours: 1, auditRetentionDays: 1 };
const sha1 = (bytes: Uint8Array): Buffer => createHash('sha1').update(bytes).digest();
const snapshotHash = (root: string): string => {
  const entries: unknown[] = [];
  const visit = (path: string): void => {
    const stat = fs.lstatSync(path);
    entries.push({ path: path.slice(root.length), mode: stat.mode, inode: stat.ino, links: stat.nlink, size: stat.size,
      modified: stat.mtimeMs, changed: stat.ctimeMs, hash: stat.isFile() ? hashReadonlyValue(fs.readFileSync(path)) : '' });
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); return hashReadonlyValue(canonicalReadonlyJson(entries));
};
const prepare = async (registration: CompanyReadonlyRegistration) => {
  const repository = await adapter.inspect(registration, randomUUID());
  const collected = await adapter.collect(repository, registration);
  const prepared = createCompanyReadonlyPreparation(registration, policy, repository, collected,
    { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-11-17T00:00:00.000Z') });
  validateCompanyReadonlyPayload(prepared.plan, prepared.payload); adapter.assertUnchanged(prepared.payload); return prepared;
};
const rejectsSource = async (registration: CompanyReadonlyRegistration): Promise<void> => {
  await assert.rejects(adapter.inspect(registration, randomUUID()), error => {
    assert.equal((error as { code?: string }).code, 'COMPANY_READONLY_SOURCE_CHANGED');
    assert.equal(String(error).includes(registration.sourceRoot), false); return true;
  });
};

test('valid synthetic over-limit pack is refused while the same commit in a six-file review copy passes unchanged', async context => {
  const fixture = await createCompanyEvidenceCopyFixture(context, 'over-limit-pack');
  const sourceBefore = snapshotHash(fixture.sourceRoot), copyBefore = snapshotHash(fixture.copyRoot);
  assert.ok(fixture.sourcePackPath); assert.ok(fixture.sourceIndexPath);
  const pack = fs.readFileSync(fixture.sourcePackPath), index = fs.readFileSync(fixture.sourceIndexPath);
  assert.equal(pack.toString('ascii', 0, 4), 'PACK'); assert.equal(pack.readUInt32BE(8), fixture.packedObjectCount);
  assert.ok(fixture.packedObjectCount > 4096); assert.equal(fixture.indexedObjectCount, fixture.packedObjectCount);
  assert.equal(index.readUInt32BE(0), 0xff744f63); assert.equal(index.readUInt32BE(4), 2);
  assert.equal(index.readUInt32BE(1028), fixture.packedObjectCount);
  assert.deepEqual(sha1(pack.subarray(0, -20)), pack.subarray(-20));
  assert.deepEqual(sha1(index.subarray(0, -20)), index.subarray(-20));
  assert.deepEqual(index.subarray(-40, -20), pack.subarray(-20));
  assert.ok(pack.length < 8 * 1024 * 1024); assert.ok(index.length < 8 * 1024 * 1024);
  assert.deepEqual(fs.readdirSync(join(fixture.sourceRoot, '.git/objects')).filter(name => /^[a-f0-9]{2}$/u.test(name)), []);
  const original = await git.readObject({ fs, dir: fixture.sourceRoot, oid: fixture.commit.oid, format: 'content' });
  assert.equal(original.format, 'content'); assert.equal(original.type, 'commit');
  assert.deepEqual(Buffer.from(original.object as Uint8Array), fixture.commit.content);
  await rejectsSource(fixture.sourceRegistration);

  const prepared = await prepare(fixture.registration), repository = prepared.payload.repository;
  assert.equal(repository.kind, 'company-git'); assert.equal(repository.headRef, null);
  assert.equal(repository.baseCommit, fixture.sourceRegistration.baseCommit);
  assert.equal(fs.readFileSync(join(fixture.copyRoot, '.git/HEAD'), 'utf8'), `${fixture.commit.oid}\n`);
  assert.deepEqual(await git.listFiles({ fs, dir: fixture.copyRoot }), fixture.selectedPaths);
  assert.deepEqual(repository.readAllowedFiles, fixture.selectedPaths); assert.equal(prepared.payload.collected.evidence.length, 6);
  assert.equal(prepared.plan.collectionProfileHash, getPersonalCollectionProfileHash());
  const input = JSON.parse(prepared.payload.reviewInput);
  assert.equal(input.mode, 'offline'); assert.equal(input.repository.baseCommit, fixture.commit.oid);
  assert.deepEqual(input.tools, []); assert.equal(input.executionAllowed, false); assert.equal(input.transmissionAllowed, false);
  assert.equal(sourceBefore, snapshotHash(fixture.sourceRoot)); assert.equal(copyBefore, snapshotHash(fixture.copyRoot));
});

test('copy retains exact ancestor-tree metadata and original commit but omits unselected blobs and history', async context => {
  const fixture = await createCompanyEvidenceCopyFixture(context);
  const sourceBefore = snapshotHash(fixture.sourceRoot), copyBefore = snapshotHash(fixture.copyRoot);
  for (const object of fixture.copiedObjects) {
    const source = await git.readObject({ fs, dir: fixture.sourceRoot, oid: object.oid, format: 'content' });
    const copy = await git.readObject({ fs, dir: fixture.copyRoot, oid: object.oid, format: 'content' });
    assert.equal(source.type, object.type); assert.equal(copy.type, object.type);
    assert.deepEqual(Buffer.from(source.object as Uint8Array), object.content);
    assert.deepEqual(Buffer.from(copy.object as Uint8Array), object.content);
    assert.equal(sha1(Buffer.concat([Buffer.from(`${object.type} ${object.content.length}\0`), object.content])).toString('hex'), object.oid);
  }
  assert.equal(fixture.copiedObjects.filter(object => object.type === 'commit').length, 1);
  assert.match(fixture.commit.content.toString('utf8'), /^parent [a-f0-9]{40}$/mu);
  assert.equal(fixture.ancestorTrees.length, 6);
  const treeMetadata = Buffer.concat(fixture.ancestorTrees.map(object => object.content)).toString('utf8');
  assert.match(treeMetadata, /unselected\.ts/u); assert.match(treeMetadata, /private-note\.ts/u); assert.match(treeMetadata, /docs/u);
  for (const object of fixture.omittedObjects) {
    assert.equal(fs.existsSync(join(fixture.copyRoot, '.git/objects', object.oid.slice(0, 2), object.oid.slice(2))), false);
    await assert.rejects(git.readObject({ fs, dir: fixture.copyRoot, oid: object.oid, format: 'content' }));
  }
  for (const path of Object.keys(fixture.omittedFiles)) assert.equal(fs.existsSync(join(fixture.copyRoot, path)), false);
  const actualOids = fs.readdirSync(join(fixture.copyRoot, '.git/objects')).filter(name => /^[a-f0-9]{2}$/u.test(name))
    .flatMap(prefix => fs.readdirSync(join(fixture.copyRoot, '.git/objects', prefix)).map(name => prefix + name)).sort();
  assert.deepEqual(actualOids, fixture.copiedObjects.map(object => object.oid).sort());
  const prepared = await prepare(fixture.registration);
  assert.equal(prepared.payload.reviewInput.includes('SYNTHETIC_OMITTED'), false);
  for (const path of ['src/api/unselected.ts', 'docs/internal.md']) {
    await rejectsSource({ ...fixture.registration, readRanges: [...fixture.registration.readRanges, { path, startLine: 1, endLine: 1 }],
      reviewPaths: [...fixture.registration.reviewPaths, path] });
  }
  assert.equal(sourceBefore, snapshotHash(fixture.sourceRoot)); assert.equal(copyBefore, snapshotHash(fixture.copyRoot));
});

test('missing or validly compressed but altered commit, ancestor tree and selected blob are rejected', async context => {
  const fixture = await createCompanyEvidenceCopyFixture(context);
  const sourceBefore = snapshotHash(fixture.sourceRoot);
  for (const path of Object.values(fixture.copyObjectPaths)) {
    const original = fs.readFileSync(path);
    fs.unlinkSync(path); await rejectsSource(fixture.registration); fs.writeFileSync(path, original, { mode: 0o600 });
    const changed = inflateSync(original); changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    fs.writeFileSync(path, deflateSync(changed)); await rejectsSource(fixture.registration); fs.writeFileSync(path, original);
  }
  await prepare(fixture.registration);
  assert.equal(sourceBefore, snapshotHash(fixture.sourceRoot));
});

test('selected working bytes, staged index and detached HEAD must each agree with the fixed original commit', async context => {
  const fixture = await createCompanyEvidenceCopyFixture(context), path = 'src/shared/value.ts';
  const workingPath = join(fixture.copyRoot, path), indexPath = join(fixture.copyRoot, '.git/index'), headPath = join(fixture.copyRoot, '.git/HEAD');
  const original = fs.readFileSync(workingPath), originalIndex = fs.readFileSync(indexPath), originalHead = fs.readFileSync(headPath);
  fs.writeFileSync(workingPath, 'export const value = 43;\n'); await rejectsSource(fixture.registration);
  await git.add({ fs, dir: fixture.copyRoot, filepath: path }); fs.writeFileSync(workingPath, original);
  await rejectsSource(fixture.registration); fs.writeFileSync(indexPath, originalIndex);
  fs.appendFileSync(indexPath, 'SYNTHETIC_BAD_INDEX'); await rejectsSource(fixture.registration); fs.writeFileSync(indexPath, originalIndex);
  fs.writeFileSync(headPath, `${'0'.repeat(40)}\n`); await rejectsSource(fixture.registration); fs.writeFileSync(headPath, originalHead);
  await prepare(fixture.registration);
});

test('copy identity and guard apply to its registered path, and cannot attest to later original changes', async context => {
  const fixture = await createCompanyEvidenceCopyFixture(context);
  const original = await prepare(fixture.sourceRegistration), copy = await prepare(fixture.registration);
  assert.notEqual(original.payload.repository.sourceRoot, copy.payload.repository.sourceRoot);
  assert.equal(copy.payload.repository.sourceRoot, fixture.copyRoot);
  assert.equal(original.payload.repository.baseCommit, copy.payload.repository.baseCommit);
  assert.equal(original.payload.repository.sourceManifestHash, copy.payload.repository.sourceManifestHash);
  assert.notEqual(original.plan.registrationHash, copy.plan.registrationHash);
  assert.notEqual(original.plan.sourceIdentityHash, copy.plan.sourceIdentityHash);
  await assert.rejects(adapter.collect(copy.payload.repository, fixture.sourceRegistration), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  const copyBefore = snapshotHash(fixture.copyRoot);
  fs.writeFileSync(join(fixture.sourceRoot, 'src/shared/value.ts'), 'export const value = 99;\n');
  fs.writeFileSync(join(fixture.sourceRoot, '.git/HEAD'), `${'0'.repeat(40)}\n`);
  assert.throws(() => adapter.assertUnchanged(original.payload), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  assert.doesNotThrow(() => adapter.assertUnchanged(copy.payload));
  assert.equal(copyBefore, snapshotHash(fixture.copyRoot));
  fs.writeFileSync(join(fixture.copyRoot, 'src/shared/value.ts'), 'export const value = 43;\n');
  assert.throws(() => adapter.assertUnchanged(copy.payload), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  await assert.rejects(adapter.collect(copy.payload.repository, fixture.registration), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
});

test('copy guard rejects observed Git metadata changes even when selected worktree bytes stay unchanged', async context => {
  const fixture = await createCompanyEvidenceCopyFixture(context), copy = await prepare(fixture.registration);
  const sourceBefore = snapshotHash(fixture.sourceRoot);
  fs.appendFileSync(join(fixture.copyRoot, '.git/index'), 'SYNTHETIC_POST_COLLECTION_CHANGE');
  assert.throws(() => adapter.assertUnchanged(copy.payload), { code: 'COMPANY_READONLY_SOURCE_CHANGED' });
  assert.equal(sourceBefore, snapshotHash(fixture.sourceRoot));
});
