import assert from 'node:assert/strict';
import * as gitFileSystem from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import git from 'isomorphic-git';
import { prepareDemoRepository, hashRepository } from '../src/adapters/demo-repository.js';
import { LocalGitReader } from '../src/adapters/local-git-reader.js';
import { HarnessError } from '../src/domain/errors.js';
import type { ReadRequest, RepositoryPolicy } from '../src/domain/types.js';

const temporaryDirectories: string[] = [];
let demoPolicy: RepositoryPolicy;

const makeTemporaryDirectory = async (): Promise<string> => {
  const root = await fileSystem.realpath(await fileSystem.mkdtemp(join(tmpdir(), 'harness-repository-test-')));
  temporaryDirectories.push(root);
  return root;
};

const makeRepository = async (
  files: Record<string, string | Uint8Array>,
  symlinks: Record<string, string> = {},
): Promise<RepositoryPolicy> => {
  const root = await makeTemporaryDirectory();
  for (const [path, content] of Object.entries(files)) {
    await fileSystem.mkdir(dirname(join(root, path)), { recursive: true });
    await fileSystem.writeFile(join(root, path), content);
  }
  for (const [path, target] of Object.entries(symlinks)) {
    await fileSystem.mkdir(dirname(join(root, path)), { recursive: true });
    await fileSystem.symlink(target, join(root, path));
  }
  await git.init({ fs: gitFileSystem, dir: root, defaultBranch: 'main' });
  const allowedPaths = [...Object.keys(files), ...Object.keys(symlinks)];
  for (const filepath of allowedPaths) await git.add({ fs: gitFileSystem, dir: root, filepath });
  const baseCommit = await git.commit({
    fs: gitFileSystem, dir: root, message: 'Synthetic boundary test',
    author: { name: 'Synthetic Test', email: 'test@example.invalid', timestamp: 1704067200, timezoneOffset: 0 },
  });
  return { repoId: 'sample', root, baseCommit, allowedPaths, maxFileBytes: 32 * 1024, maxEvidenceBytes: 16 * 1024 };
};

const readRequest = (path: string, extra: Partial<ReadRequest> = {}): ReadRequest => {
  return { repoId: 'sample', path, startLine: 1, endLine: 1, ...extra };
};

const assertBlocked = async (
  policy: RepositoryPolicy,
  request: ReadRequest,
  code?: string,
): Promise<void> => {
  await assert.rejects(new LocalGitReader(policy).read(request), (error: unknown) => {
    assert.ok(error instanceof HarnessError);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, error.code);
    assert.ok(!error.message.includes(policy.root));
    return true;
  });
};

const makeWritable = async (path: string): Promise<void> => {
  const metadata = await fileSystem.lstat(path);
  if (metadata.isSymbolicLink()) return;
  await fileSystem.chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) {
    for (const name of await fileSystem.readdir(path)) await makeWritable(join(path, name));
  }
};

before(async () => {
  demoPolicy = await prepareDemoRepository();
  temporaryDirectories.push(demoPolicy.root);
});

after(async () => {
  for (const root of temporaryDirectories) {
    await makeWritable(root);
    await fileSystem.rm(root, { recursive: true, force: true });
  }
});

test('fixed commit evidence records exact lines and leaves every repository entry unchanged', async () => {
  const beforeHash = await hashRepository(demoPolicy.root);
  const request = readRequest('src/orders.service.ts', { endLine: 10 });
  const evidence = await new LocalGitReader(demoPolicy).read(request);
  assert.deepEqual({ ...evidence, excerpt: undefined }, { ...request, baseCommit: demoPolicy.baseCommit, excerpt: undefined });
  assert.match(evidence.excerpt, /status: 409/u);
  assert.equal(evidence.excerpt.split('\n').length, 10);
  assert.equal(await hashRepository(demoPolicy.root), beforeHash);
  assert.equal((await fileSystem.stat(demoPolicy.root)).mode & 0o222, 0);
  assert.equal((await fileSystem.stat(join(demoPolicy.root, 'src/orders.service.ts'))).mode & 0o222, 0);
});

test('working tree edits and policy object edits do not change the pinned committed evidence', async () => {
  const policy = await makeRepository({ 'source.ts': 'committed evidence\n', 'extra.ts': 'extra\n' });
  policy.allowedPaths = ['source.ts'];
  const reader = new LocalGitReader(policy);
  await fileSystem.writeFile(join(policy.root, 'source.ts'), 'uncommitted replacement\n');
  policy.allowedPaths.push('extra.ts');
  policy.baseCommit = '0'.repeat(40);
  assert.equal((await reader.read(readRequest('source.ts'))).excerpt, 'committed evidence');
  await assert.rejects(reader.read(readRequest('extra.ts')), { message: 'PATH_NOT_ALLOWED' });
});

test('repository identity, exact allowlist and canonical relative paths are required', async () => {
  await assertBlocked(demoPolicy, readRequest('src/orders.service.ts', { repoId: 'other' }), 'REPOSITORY_NOT_ALLOWED');
  await assertBlocked(demoPolicy, readRequest('src/missing.service.ts'), 'PATH_NOT_ALLOWED');
  for (const path of ['../outside.txt', '/etc/passwd', 'src/../README.md', 'src\\orders.service.ts', 'src//orders.service.ts', './README.md', 'src/\0file', 'C:/outside']) {
    await assertBlocked(demoPolicy, readRequest(path), 'INVALID_REPOSITORY_PATH');
  }
  assert.throws(() => new LocalGitReader({ ...demoPolicy, baseCommit: 'HEAD' }), { message: 'INVALID_REPOSITORY_POLICY' });
  assert.throws(() => new LocalGitReader({ ...demoPolicy, allowedPaths: ['../outside'] }), { message: 'INVALID_REPOSITORY_POLICY' });
});

test('secret, large and binary fixtures are denied even when their paths are allowlisted', async () => {
  const beforeHash = await hashRepository(demoPolicy.root);
  for (const path of ['.env', '.env.local', '.npmrc', '.netrc', '.aws/config', 'credentials.json', 'id_ed25519', 'server.key']) {
    const policy = { ...demoPolicy, allowedPaths: [...demoPolicy.allowedPaths, path] };
    await assertBlocked(policy, readRequest(path), 'SECRET_FILE_BLOCKED');
  }
  await assertBlocked(demoPolicy, readRequest('src/large.ts'), 'FILE_TOO_LARGE');
  await assertBlocked(demoPolicy, readRequest('src/binary.ts'), 'BINARY_FILE_BLOCKED');
  await assertBlocked(demoPolicy, readRequest('src/linked.ts'), 'SYMLINK_BLOCKED');
  assert.equal(await hashRepository(demoPolicy.root), beforeHash);
});

test('credential patterns anywhere in a file are blocked before excerpt selection', async () => {
  const policy = await makeRepository({
    'source.ts': `safe first line\nconst fixture = 'github_pat_${'FAKE'.repeat(10)}';\n`,
  });
  await assertBlocked(policy, readRequest('source.ts'), 'SECRET_CONTENT_BLOCKED');
});

test('line count, actual line bounds and evidence byte limits fail closed', async () => {
  const invalidRanges: Partial<ReadRequest>[] = [
    { startLine: 0 }, { endLine: 0 }, { endLine: 201 }, { startLine: 1.5 }, { endLine: 100 },
  ];
  for (const range of invalidRanges) {
    await assertBlocked(demoPolicy, readRequest('src/orders.service.ts', range), 'INVALID_LINE_RANGE');
  }
  const policy = await makeRepository({ 'source.ts': 'large excerpt on one line\n' });
  await assertBlocked({ ...policy, maxEvidenceBytes: 4 }, readRequest('source.ts'), 'EVIDENCE_TOO_LARGE');
});

test('commit tree symlinks remain denied after replacement with a regular working file', async () => {
  const policy = await makeRepository({ 'safe.ts': 'safe\n' }, { 'linked.ts': '../outside-synthetic.txt' });
  await fileSystem.unlink(join(policy.root, 'linked.ts'));
  await fileSystem.writeFile(join(policy.root, 'linked.ts'), 'working replacement\n');
  await assertBlocked(policy, readRequest('linked.ts'), 'SYMLINK_BLOCKED');
});

test('symlinks in a source directory, Git directory and Git object store cannot escape the root', async () => {
  for (const linkPath of ['src', '.git', '.git/objects']) {
    const policy = await makeRepository({ 'src/source.ts': 'safe committed evidence\n' });
    const outside = await makeTemporaryDirectory();
    const original = join(policy.root, linkPath);
    const moved = join(outside, 'moved');
    await fileSystem.rename(original, moved);
    await fileSystem.symlink(moved, original);
    await assertBlocked(policy, readRequest('src/source.ts'));
  }
});

test('repository root symlinks and oversized loose object inflation are denied', async () => {
  const policy = await makeRepository({ 'source.ts': 'safe\n' });
  const outside = await makeTemporaryDirectory();
  const rootLink = join(outside, 'root-link');
  await fileSystem.symlink(policy.root, rootLink);
  await assertBlocked({ ...policy, root: rootLink }, readRequest('source.ts'), 'SYMLINK_BLOCKED');

  const largePolicy = await makeRepository({ 'source.ts': `${'x'.repeat(3 * 1024 * 1024)}\n` });
  await assertBlocked(largePolicy, readRequest('source.ts'));
});

test('snapshot hash includes untracked files, Git metadata, file mode and symlink targets', async () => {
  const policy = await makeRepository({ 'source.ts': 'safe\n' });
  let previous = await hashRepository(policy.root);
  const verifyChanged = async (): Promise<void> => {
    const current = await hashRepository(policy.root);
    assert.notEqual(current, previous);
    previous = current;
  };
  await fileSystem.writeFile(join(policy.root, 'untracked.txt'), 'synthetic untracked content');
  await verifyChanged();
  await fileSystem.writeFile(join(policy.root, '.git/metadata-fixture'), 'synthetic metadata');
  await verifyChanged();
  await fileSystem.chmod(join(policy.root, 'source.ts'), 0o444);
  await verifyChanged();
  await fileSystem.symlink('source.ts', join(policy.root, 'linked.ts'));
  await verifyChanged();
  await fileSystem.unlink(join(policy.root, 'linked.ts'));
  await fileSystem.symlink('untracked.txt', join(policy.root, 'linked.ts'));
  await verifyChanged();
});
