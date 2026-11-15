import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { assertPersonalReadonlyRepository, assertPersonalReadonlyRepositoryNow, collectPersonalReadonlyEvidence,
  inspectPersonalReadonlyRepository } from '../src/adapters/personal-readonly-repository.js';
import type { PersonalReadonlyRegistration } from '../src/domain/personal-readonly.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const author = { name: 'Synthetic Reader', email: 'reader@example.invalid', timestamp: 1704067200, timezoneOffset: 0 };
const body = 'export const answer = 42;\n// Evidence only; never execute target code.\n';
const setup = async (context: TestContext, files: Record<string, string | Buffer> = { 'src/service.ts': body }) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'personal-readonly-test-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) { fs.mkdirSync(dirname(join(root, path)), { recursive: true }); fs.writeFileSync(join(root, path), content); }
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  for (const filepath of Object.keys(files)) await git.add({ fs, dir: root, filepath });
  const baseCommit = await git.commit({ fs, dir: root, author, committer: author, message: 'Synthetic reader fixture' });
  const registration: PersonalReadonlyRegistration = { version: 'personal-readonly-registration-v1', repoId: 'personal-test', sourceRoot: root,
    baseCommit, question: 'Explain the selected function with supplied evidence.',
    readRanges: [{ path: Object.keys(files)[0]!, startLine: 1, endLine: 1 }], transferPaths: [Object.keys(files)[0]!] };
  return { root, registration };
};
const snapshot = (root: string): string => {
  const entries: unknown[] = [];
  const visit = (path: string): void => {
    const item = fs.lstatSync(path);
    entries.push({ path: path.slice(root.length), mode: item.mode, inode: item.ino, links: item.nlink, size: item.size,
      modified: item.mtimeMs, changed: item.ctimeMs, hash: item.isFile() ? hashReadonlyValue(fs.readFileSync(path)) : '' });
    if (item.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); return canonicalReadonlyJson(entries);
};
const packFixture = async (root: string): Promise<string> => {
  const objects = join(root, '.git/objects');
  const prefixes = fs.readdirSync(objects).filter((name) => /^[a-f0-9]{2}$/u.test(name));
  const oids = prefixes.flatMap((prefix) => fs.readdirSync(join(objects, prefix)).map((name) => prefix + name));
  const pack = await git.packObjects({ fs, dir: root, oids, write: false });
  const path = join(objects, 'pack', pack.filename);
  fs.writeFileSync(path, pack.packfile!);
  await git.indexPack({ fs, dir: root, filepath: `.git/objects/pack/${pack.filename}` });
  for (const prefix of prefixes) fs.rmSync(join(objects, prefix), { recursive: true });
  return path;
};
const rejects = async (registration: PersonalReadonlyRegistration): Promise<void> => {
  await assert.rejects(inspectPersonalReadonlyRepository(registration, randomUUID()), { code: 'PERSONAL_READONLY_UNSAFE_REPOSITORY' });
};

test('personal reader collects deterministic committed evidence without any source/Git modification', async (context) => {
  const { root, registration } = await setup(context);
  const before = snapshot(root);
  const repository = await inspectPersonalReadonlyRepository(registration, randomUUID());
  assert.equal(repository.kind, 'personal-git'); assert.equal(repository.headRef, 'refs/heads/main');
  assert.deepEqual(repository.readAllowedFiles, ['src/service.ts']);
  const evidence = await collectPersonalReadonlyEvidence(repository, registration);
  assert.equal(evidence[0]?.excerpt, body.split('\n')[0]);
  assert.equal(evidence[0]?.fileHash, hashReadonlyValue(body));
  assert.equal(repository.gitEntries.some((item) => item.path === '.git/config'), false);
  await assertPersonalReadonlyRepository(repository); assertPersonalReadonlyRepositoryNow(repository);
  assert.deepEqual(await collectPersonalReadonlyEvidence(repository, registration), evidence);
  assert.equal(snapshot(root), before);
});

test('personal reader supports bounded packed objects and packed HEAD refs without reading config/hooks/unselected secrets', async (context) => {
  const { root, registration } = await setup(context);
  await packFixture(root);
  fs.writeFileSync(join(root, '.git/packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${registration.baseCommit} refs/heads/main\n`);
  fs.unlinkSync(join(root, '.git/refs/heads/main'));
  fs.writeFileSync(join(root, '.env'), 'unselected-private-file');
  const before = snapshot(root), opened: string[] = [];
  const original = fs.openSync;
  fs.openSync = ((path, ...args) => {
    const name = String(path); opened.push(name);
    assert.equal(name.endsWith('/.git/config') || name.endsWith('/.env') || name.includes('/.git/hooks/'), false);
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    const repository = await inspectPersonalReadonlyRepository(registration, randomUUID());
    assert.ok(repository.gitEntries.some((item) => item.path.endsWith('.pack')));
    assert.ok(repository.gitEntries.some((item) => item.path.endsWith('.idx')));
    assert.ok(repository.gitEntries.some((item) => item.path === '.git/packed-refs'));
    assert.equal((await collectPersonalReadonlyEvidence(repository, registration)).length, 1);
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.ok(opened.length > 0); assert.equal(snapshot(root), before);
});

test('personal reader permits unrelated working changes without claiming repository-wide clean status', async (context) => {
  const { root, registration } = await setup(context, { 'src/service.ts': body, 'unselected.txt': 'original\n' });
  fs.writeFileSync(join(root, 'unselected.txt'), 'unrelated dirty content\n');
  const repository = await inspectPersonalReadonlyRepository(registration, randomUUID());
  fs.writeFileSync(join(root, 'new-unselected.txt'), 'untracked and outside observation\n');
  assertPersonalReadonlyRepositoryNow(repository);
  assert.equal((await collectPersonalReadonlyEvidence(repository, registration)).length, 1);
});

test('personal reader rejects dirty selected bytes, staged divergence, wrong base and untracked selection', async (context) => {
  for (const kind of ['dirty', 'staged', 'wrong-base', 'untracked']) {
    const { root, registration } = await setup(context);
    if (kind === 'wrong-base') registration.baseCommit = 'a'.repeat(40);
    else if (kind === 'untracked') { fs.writeFileSync(join(root, 'extra.ts'), body); registration.readRanges[0]!.path = 'extra.ts'; registration.transferPaths = ['extra.ts']; }
    else { fs.writeFileSync(join(root, 'src/service.ts'), body.replace('42', '43')); if (kind === 'staged') { await git.add({ fs, dir: root, filepath: 'src/service.ts' }); fs.writeFileSync(join(root, 'src/service.ts'), body); } }
    await rejects(registration);
  }
});

test('personal fresh guard rejects selected bytes, inode, parent, HEAD, index, ref and object mutation', async (context) => {
  for (const kind of ['bytes', 'inode', 'parent', 'HEAD', 'index', 'ref', 'object']) {
    const { root, registration } = await setup(context);
    const repository = await inspectPersonalReadonlyRepository(registration, randomUUID());
    if (kind === 'bytes') fs.writeFileSync(join(root, 'src/service.ts'), body.replace('42', '43'));
    if (kind === 'inode') { fs.unlinkSync(join(root, 'src/service.ts')); fs.writeFileSync(join(root, 'src/service.ts'), body); }
    if (kind === 'parent') { fs.renameSync(join(root, 'src'), join(root, 'old-src')); fs.mkdirSync(join(root, 'src')); fs.writeFileSync(join(root, 'src/service.ts'), body); }
    if (kind === 'HEAD') fs.writeFileSync(join(root, '.git/HEAD'), `${registration.baseCommit}\n`);
    if (kind === 'index') fs.appendFileSync(join(root, '.git/index'), 'X');
    if (kind === 'ref') fs.writeFileSync(join(root, '.git/refs/heads/main'), `${'b'.repeat(40)}\n`);
    if (kind === 'object') { const path = repository.gitEntries.find((item) => item.path.includes('/objects/'))!.path; fs.appendFileSync(join(root, path), 'X'); }
    assert.throws(() => assertPersonalReadonlyRepositoryNow(repository), { code: 'PERSONAL_READONLY_UNSAFE_REPOSITORY' });
    await assert.rejects(collectPersonalReadonlyEvidence(repository, registration));
  }
});

test('personal reader rejects file and parent symlinks, hardlinks and .git indirection', async (context) => {
  for (const kind of ['file-symlink', 'parent-symlink', 'hardlink', 'gitfile', 'git-symlink']) {
    const { root, registration } = await setup(context);
    const path = join(root, 'src/service.ts');
    if (kind === 'hardlink') fs.linkSync(path, join(root, 'linked-copy'));
    if (kind === 'file-symlink') { fs.renameSync(path, join(root, 'outside.ts')); fs.symlinkSync('../outside.ts', path); }
    if (kind === 'parent-symlink') { fs.renameSync(join(root, 'src'), join(root, 'outside')); fs.symlinkSync('outside', join(root, 'src')); }
    if (kind === 'gitfile' || kind === 'git-symlink') { fs.renameSync(join(root, '.git'), join(root, 'actual-git')); if (kind === 'gitfile') fs.writeFileSync(join(root, '.git'), 'gitdir: actual-git\n'); else fs.symlinkSync('actual-git', join(root, '.git')); }
    await rejects(registration);
  }
});

test('personal registration rejects escaping, secrets/config, bad descriptors and limits before opening source', async (context) => {
  const { root, registration } = await setup(context); let accesses = 0;
  const original = fs.openSync;
  fs.openSync = ((...args) => { accesses++; return Reflect.apply(original, fs, args); }) as typeof fs.openSync; syncBuiltinESMExports();
  try {
    for (const path of ['../outside', '/etc/passwd', 'src/../service.ts', '.env', 'config.json', 'secrets.txt', '.git/config', 'src\\escape']) {
      await rejects({ ...registration, readRanges: [{ path, startLine: 1, endLine: 1 }], transferPaths: [path] });
    }
    let getter = 0;
    const accessor = { ...registration }; Object.defineProperty(accessor, 'question', { get: () => { getter++; return 'bad'; }, enumerable: true });
    await rejects(accessor); assert.equal(getter, 0);
    const inherited = [...registration.readRanges];
    Object.setPrototypeOf(inherited, Object.create(Array.prototype, { map: { get: () => { getter++; throw new Error('must not run'); } } }));
    await rejects({ ...registration, readRanges: inherited }); assert.equal(getter, 0);
    await rejects({ ...registration, readRanges: [{ path: 'src/service.ts', startLine: 1, endLine: 201 }] });
    await rejects({ ...registration, sourceRoot: `${root}/../${root.split('/').at(-1)}` });
    await rejects({ ...registration, transferPaths: ['other.ts'] });
    await rejects({ ...registration, question: 'x'.repeat(4097) });
    assert.equal(accesses, 0);
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
});

test('personal reader rejects binary, full-file secrets and files over the unchanged 32KiB bound', async (context) => {
  for (const content of [Buffer.from([1, 0, 255]), 'safe line\npassword = "synthetic-private-value"\n', 'x'.repeat(32769)]) {
    const { registration } = await setup(context, { 'selected.ts': content }); await rejects(registration);
  }
});

test('personal reader rejects decompression bombs and malformed pack/index without returning evidence', async (context) => {
  const { root, registration } = await setup(context);
  const object = join(root, '.git/objects', registration.baseCommit.slice(0, 2), registration.baseCommit.slice(2));
  fs.writeFileSync(object, deflateSync(Buffer.from(`commit ${2 * 1024 * 1024}\0${'x'.repeat(2 * 1024 * 1024)}`)));
  await rejects(registration);
  const packed = await setup(context); const pack = await packFixture(packed.root);
  const bytes = fs.readFileSync(pack); bytes.writeUInt32BE(4097, 8);
  createHash('sha1').update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20);
  fs.writeFileSync(pack, bytes); await rejects(packed.registration);
});

test('personal reader errors contain no source paths or excerpts and forged nested getters never run', async (context) => {
  const { root, registration } = await setup(context);
  const repository = await inspectPersonalReadonlyRepository(registration, randomUUID());
  let calls = 0;
  const altered = structuredClone(repository);
  Object.defineProperty(altered.manifest[0]!, 'path', { get: () => { calls++; return 'src/service.ts'; }, enumerable: true });
  assert.throws(() => assertPersonalReadonlyRepositoryNow(altered), (error) => {
    assert.equal(String(error).includes(root), false); assert.equal(String(error).includes('42'), false); return true;
  });
  assert.equal(calls, 0);
  assert.throws(() => assertPersonalReadonlyRepositoryNow({ ...repository, identityHash: 'a'.repeat(64) }));
});

test('personal manifest ordering stays deterministic across mixed case and punctuation', async (context) => {
  const { registration } = await setup(context, { 'a.ts': body, 'A.ts': body, '_service.ts': body });
  registration.readRanges = ['a.ts', 'A.ts', '_service.ts'].map((path) => ({ path, startLine: 1, endLine: 1 }));
  registration.transferPaths = ['a.ts', 'A.ts', '_service.ts'];
  const repository = await inspectPersonalReadonlyRepository(registration, randomUUID());
  assertPersonalReadonlyRepositoryNow(repository);
  assert.equal((await collectPersonalReadonlyEvidence(repository, registration)).length, 3);
});

test('personal selected-file replacement during a read is rejected without repairing or reading replacement bytes', async (context) => {
  const { root, registration } = await setup(context);
  const selected = join(root, 'src/service.ts'), inode = fs.statSync(selected).ino;
  const original = fs.readSync; let replaced = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(original, fs, args) as number;
    if (!replaced && fs.fstatSync(args[0]).ino === inode) {
      replaced = true; fs.renameSync(selected, join(root, 'old-service.ts')); fs.writeFileSync(selected, body);
    }
    return result;
  }) as typeof fs.readSync; syncBuiltinESMExports();
  try { await rejects(registration); assert.equal(replaced, true); }
  finally { fs.readSync = original; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(join(root, 'old-service.ts')), true);
});

test('personal packed index cannot substitute a different content object under a forged commit OID', async (context) => {
  const { root, registration } = await setup(context); const pack = await packFixture(root);
  const index = pack.replace(/\.pack$/u, '.idx'), bytes = fs.readFileSync(index);
  const real = Buffer.from(registration.baseCommit, 'hex'), position = bytes.indexOf(real, 1032);
  assert.ok(position >= 1032);
  const forged = Buffer.from(real); forged[19] = forged[19]! ^ 1;
  forged.copy(bytes, position); createHash('sha1').update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20);
  fs.writeFileSync(index, bytes); registration.baseCommit = forged.toString('hex');
  fs.writeFileSync(join(root, '.git/refs/heads/main'), `${registration.baseCommit}\n`);
  await rejects(registration);
});

test('personal committed symlink mode is refused even when a regular working file matches its blob bytes', async (context) => {
  const { root, registration } = await setup(context);
  const selected = join(root, 'src/service.ts'); fs.unlinkSync(selected); fs.symlinkSync('../destination', selected);
  await git.add({ fs, dir: root, filepath: 'src/service.ts' });
  registration.baseCommit = await git.commit({ fs, dir: root, author, committer: author, message: 'Synthetic symlink fixture' });
  fs.unlinkSync(selected); fs.writeFileSync(selected, '../destination');
  await rejects(registration);
});

test('personal blob entry cannot peel an annotated tag into a different blob OID', async (context) => {
  const { root, registration } = await setup(context);
  const blob = await git.readBlob({ fs, dir: root, oid: registration.baseCommit, filepath: 'src/service.ts' });
  const tag = await git.writeObject({ fs, dir: root, type: 'tag', format: 'content', object: Buffer.from(
    `object ${blob.oid}\ntype blob\ntag synthetic-indirection\ntagger Synthetic Reader <reader@example.invalid> 1704067200 +0000\n\nSynthetic malformed tree fixture\n`) });
  const sourceTree = await git.writeTree({ fs, dir: root, tree: [{ mode: '100644', path: 'service.ts', oid: tag, type: 'blob' }] });
  const tree = await git.writeTree({ fs, dir: root, tree: [{ mode: '040000', path: 'src', oid: sourceTree, type: 'tree' }] });
  const commit = await git.readCommit({ fs, dir: root, oid: registration.baseCommit });
  registration.baseCommit = await git.writeCommit({ fs, dir: root, commit: { ...commit.commit, tree } });
  await git.writeRef({ fs, dir: root, ref: 'refs/heads/main', value: registration.baseCommit, force: true });
  await rejects(registration);
});

test('personal guard refuses a new loose ref shadowing the registered packed ref even at the same commit', async (context) => {
  const { root, registration } = await setup(context);
  fs.writeFileSync(join(root, '.git/packed-refs'), `${registration.baseCommit} refs/heads/main\n`);
  fs.unlinkSync(join(root, '.git/refs/heads/main'));
  const repository = await inspectPersonalReadonlyRepository(registration, randomUUID());
  fs.writeFileSync(join(root, '.git/refs/heads/main'), `${registration.baseCommit}\n`);
  assert.throws(() => assertPersonalReadonlyRepositoryNow(repository), { code: 'PERSONAL_READONLY_UNSAFE_REPOSITORY' });
  assert.equal(fs.readFileSync(join(root, '.git/refs/heads/main'), 'utf8'), `${registration.baseCommit}\n`);
});
