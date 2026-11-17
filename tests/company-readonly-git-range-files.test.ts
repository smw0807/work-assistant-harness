import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCompanyGitRangeFiles, type CompanyGitRangeFiles } from '../src/adapters/company-git-range-files.js';
import { CompanyGitRangeBudget, getCompanyGitRangeProfile } from '../src/policy/company-git-range-budget.js';

const limits = getCompanyGitRangeProfile().limits;
const source = 'export const answer = 42;\n';
const packStem = `pack-${'a'.repeat(40)}`;
const active = (): CompanyGitRangeBudget => { const budget = new CompanyGitRangeBudget(0); budget.beginPass('inspect', 0); return budget; };
const fixture = (context: TestContext) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-range-files-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (path: string, content: string | Buffer): void => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true }); fs.writeFileSync(join(root, path), content);
  };
  write('.git/HEAD', `${'0'.repeat(40)}\n`); write('src/main.ts', source);
  return { root, write };
};
const session = (context: TestContext, root: string, budget = active(), now = () => 0): { files: CompanyGitRangeFiles; budget: CompanyGitRangeBudget } => {
  const files = createCompanyGitRangeFiles(root, ['src/main.ts'], budget, now);
  context.after(() => files.close()); return { files, budget };
};
const changed = (operation: () => unknown): void => assert.throws(operation, { code: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' });

test('positioned reads observe a large synthetic pack without reading its body or allocating its physical size', context => {
  const { root, write } = fixture(context), path = `.git/objects/pack/${packStem}.pack`;
  write(path, 'PACK'); write(`.git/objects/pack/${packStem}.idx`, 'synthetic-index');
  const descriptor = fs.openSync(join(root, path), 'r+'), size = 9 * 1024 * 1024;
  fs.ftruncateSync(descriptor, size); fs.writeSync(descriptor, Buffer.from('tail'), 0, 4, size - 4); fs.closeSync(descriptor);
  const { files, budget } = session(context, root);
  context.mock.method(fs, 'readFileSync', () => { throw new Error('UNEXPECTED_WHOLE_FILE_READ'); });
  const openedFlags: number[] = [], originalOpen = fs.openSync;
  context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: number, mode?: fs.Mode) => {
    openedFlags.push(flags); return originalOpen(path, flags, mode);
  }) as typeof fs.openSync);
  assert.deepEqual(files.listPacks(), [`${packStem}.idx`]);
  const handle = files.open(path, limits.packBytes)!;
  assert.equal(handle.size, size);
  for (const [offset, expected] of [[0, 'PACK'], [size - 4, 'tail'], [0, 'PACK']] as const) {
    const result = handle.read(offset, 4);
    assert.equal(result.bytes.toString(), expected); assert.equal(result.bytes.buffer.byteLength, 4);
    budget.assertMemory(result.memoryLease, 4); budget.releaseMemory(result.memoryLease);
  }
  handle.close(); files.assertUnchanged();
  assert.equal(openedFlags.length, 1);
  assert.ok((openedFlags[0]! & fs.constants.O_NOFOLLOW) !== 0);
  assert.ok((openedFlags[0]! & fs.constants.O_NONBLOCK) !== 0);
  assert.equal(budget.snapshot().readBytesReserved, 12); assert.equal(budget.snapshot().readBytesReturned, 12);
  assert.equal(budget.snapshot().readCalls, 3); assert.equal(budget.snapshot().openDescriptors, 0);
  assert.equal(budget.snapshot().liveMemoryBytes, 0); assert.equal(budget.snapshot().peakMemoryBytes, 4);
  assert.deepEqual(files.proof().files[0]!.reads, [
    { offset: 0, length: 4, sha256: createHash('sha256').update('PACK').digest('hex') },
    { offset: size - 4, length: 4, sha256: createHash('sha256').update('tail').digest('hex') },
  ]);
  assert.equal(Object.isFrozen(files.proof().files[0]!.reads), true);
  assert.equal(JSON.stringify(files.proof()).includes('synthetic-index'), false);
  files.close(); assert.throws(() => handle.read(0, 1), { code: 'COMPANY_GIT_RANGE_INVALID_FILES' });
});

test('source allowlists and denied credentials/config/native paths reject before any filesystem metadata', context => {
  const { root } = fixture(context);
  for (const path of ['../main.ts', '/etc/passwd', 'src/../main.ts', '.git/config', '.env', '.ssh/id_rsa',
    'src/config.json', 'credentials.json', 'auth.json', '.codex/auth.json', 'codex/bin', 'sandbox-exec', 'src/main.ts\0']) {
    const budget = active();
    assert.throws(() => createCompanyGitRangeFiles(root, [path], budget, () => 0), { code: 'COMPANY_GIT_RANGE_INVALID_PATH' });
    assert.equal(budget.snapshot().metadataCalls, 0); assert.equal(budget.snapshot().readCalls, 0);
  }
  let getters = 0;
  const paths = Object.defineProperty([], '0', { enumerable: true, get: () => { getters++; return 'src/main.ts'; } });
  const budget = active();
  assert.throws(() => createCompanyGitRangeFiles(root, paths, budget, () => 0), { code: 'COMPANY_GIT_RANGE_INVALID_PATH' });
  assert.equal(getters, 0); assert.equal(budget.snapshot().metadataCalls, 0);
  let traps = 0;
  const proxy = new Proxy(['src/main.ts'], { getPrototypeOf: () => { traps++; return Array.prototype; },
    get: () => { traps++; throw new Error('UNEXPECTED_PROXY_ACCESS'); } });
  const proxyBudget = active();
  assert.throws(() => createCompanyGitRangeFiles(root, proxy, proxyBudget, () => 0), { code: 'COMPANY_GIT_RANGE_INVALID_PATH' });
  assert.equal(traps, 0); assert.equal(proxyBudget.snapshot().metadataCalls, 0);
  for (const path of ['src/other.ts', '.git/config', '.git/objects/info/alternates', '.git/hooks/pre-commit',
    '.git/refs/heads/../main', '.git/refs/heads/main.lock', '.git/refs/heads/a..b']) {
    const current = session(context, root), before = current.budget.snapshot().metadataCalls;
    assert.throws(() => current.files.open(path, 8), { code: 'COMPANY_GIT_RANGE_INVALID_PATH' });
    assert.equal(current.budget.snapshot().metadataCalls, before); assert.equal(current.budget.snapshot().readCalls, 0);
  }
});

test('selected source size and Git size ceilings cannot be enlarged by an open caller', context => {
  const { root } = fixture(context);
  for (const [path, maximum] of [['src/main.ts', 65537], ['.git/HEAD', limits.gitFileBytes + 1],
    [`.git/objects/pack/${packStem}.pack`, limits.packBytes + 1], ['src/main.ts', -1]] as const) {
    const { files, budget } = session(context, root), before = budget.snapshot().metadataCalls;
    assert.throws(() => files.open(path, maximum), { code: 'COMPANY_GIT_RANGE_INVALID_PATH' });
    assert.equal(budget.snapshot().metadataCalls, before);
  }
  const { files, budget } = session(context, root);
  assert.throws(() => files.open('src/main.ts', 1), { code: 'COMPANY_GIT_RANGE_LIMIT' });
  assert.equal(budget.snapshot().readCalls, 0); assert.equal(budget.snapshot().openDescriptors, 0);
});

test('symlink, hardlink, directory and replaced parent paths never reach file content reads', context => {
  for (const kind of ['symlink', 'hardlink', 'directory', 'parent-symlink'] as const) {
    const { root } = fixture(context), path = join(root, 'src/main.ts'), other = join(root, 'copy.ts');
    fs.renameSync(path, other);
    if (kind === 'symlink') fs.symlinkSync(other, path);
    if (kind === 'hardlink') fs.linkSync(other, path);
    if (kind === 'directory') fs.mkdirSync(path);
    if (kind === 'parent-symlink') {
      fs.rmdirSync(join(root, 'src')); fs.mkdirSync(join(root, 'elsewhere')); fs.symlinkSync(join(root, 'elsewhere'), join(root, 'src'));
      fs.writeFileSync(join(root, 'elsewhere/main.ts'), source);
    }
    const { files, budget } = session(context, root);
    changed(() => files.open('src/main.ts', 65536));
    assert.equal(budget.snapshot().readCalls, 0); assert.equal(budget.snapshot().openDescriptors, 0);
  }
  const { root } = fixture(context);
  fs.renameSync(join(root, '.git'), join(root, 'git-real')); fs.symlinkSync(join(root, 'git-real'), join(root, '.git'));
  const budget = active(); changed(() => createCompanyGitRangeFiles(root, ['src/main.ts'], budget, () => 0));
  assert.equal(budget.snapshot().readCalls, 0);
});

test('parent directory mtime/link changes are irrelevant but identity and permission changes remain guarded', context => {
  const { root } = fixture(context), { files, budget } = session(context, root);
  const handle = files.open('src/main.ts', 65536)!;
  fs.mkdirSync(join(root, 'src/unrelated-directory'));
  files.assertUnchanged();
  const result = handle.read(0, source.length); assert.equal(result.bytes.toString(), source); budget.releaseMemory(result.memoryLease);
  handle.close(); const permissions = fs.statSync(join(root, 'src')).mode & 0o777;
  fs.chmodSync(join(root, 'src'), permissions ^ 0o100);
  try { changed(() => files.assertUnchanged()); assert.equal(budget.snapshot().openDescriptors, 0); }
  finally { fs.chmodSync(join(root, 'src'), permissions); }
});

test('closed file paths and replaced source parents remain in the final metadata guard', context => {
  const { root } = fixture(context), { files, budget } = session(context, root);
  const handle = files.open('src/main.ts', 65536)!; handle.close(); handle.close();
  fs.renameSync(join(root, 'src'), join(root, 'old-src')); fs.mkdirSync(join(root, 'src'));
  fs.writeFileSync(join(root, 'src/main.ts'), source);
  changed(() => files.assertUnchanged()); assert.equal(budget.snapshot().openDescriptors, 0);
  assert.equal(files.proof().files.length, 1);
});

test('optional missing files and their first missing parents reject later appearance', context => {
  for (const missingParent of [false, true]) {
    const { root, write } = fixture(context);
    if (!missingParent) fs.mkdirSync(join(root, '.git/objects/ab'), { recursive: true });
    const { files, budget } = session(context, root), path = `.git/objects/ab/${'c'.repeat(38)}`;
    assert.equal(files.open(path, limits.gitFileBytes, true), undefined); files.assertUnchanged();
    assert.ok(files.proof().absentPaths.includes(path));
    if (missingParent) {
      assert.deepEqual(files.proof().missingParents, ['.git/objects']);
      fs.mkdirSync(join(root, '.git/objects'));
    } else write(path, 'appeared');
    changed(() => files.assertUnchanged()); assert.equal(budget.snapshot().readCalls, 0);
  }
});

test('an absent pack directory is allowed for loose objects and its later creation is rejected', context => {
  const { root } = fixture(context), { files, budget } = session(context, root);
  assert.deepEqual(files.listPacks(), []); files.assertUnchanged();
  fs.mkdirSync(join(root, '.git/objects/pack'), { recursive: true });
  changed(() => files.assertUnchanged()); assert.equal(budget.snapshot().readCalls, 0);
});

test('pack listing is bounded, observes unknown names without opening them, and rejects orphan or excess pairs', context => {
  const { root, write } = fixture(context);
  write(`.git/objects/pack/${packStem}.pack`, 'pack'); write(`.git/objects/pack/${packStem}.idx`, 'index');
  write('.git/objects/pack/unknown.keep', 'content-must-not-be-read');
  const current = session(context, root);
  assert.deepEqual(current.files.listPacks(), [`${packStem}.idx`]);
  assert.equal(current.budget.snapshot().readCalls, 0); assert.equal(current.budget.snapshot().openDescriptors, 0);
  assert.ok(current.files.proof().packNames!.includes('unknown.keep'));
  write('.git/objects/pack/another.keep', 'changed'); changed(() => current.files.assertUnchanged());
  for (const [pairs, orphan] of [[1, true], [limits.candidatePairs + 1, false]] as const) {
    const next = fixture(context);
    for (let index = 0; index < pairs; index++) {
      const stem = `pack-${index.toString(16).padStart(40, '0')}`;
      next.write(`.git/objects/pack/${stem}.idx`, 'index');
      if (!orphan) next.write(`.git/objects/pack/${stem}.pack`, 'pack');
    }
    const value = session(context, next.root);
    assert.throws(() => value.files.listPacks(), { code: orphan ? 'COMPANY_GIT_RANGE_SOURCE_CHANGED' : 'COMPANY_GIT_RANGE_LIMIT' });
    assert.equal(value.budget.snapshot().openDescriptors, 0); assert.equal(value.budget.snapshot().readCalls, 0);
  }
  for (const count of [limits.packDirectoryEntries, limits.packDirectoryEntries + 1]) {
    const next = fixture(context);
    for (let index = 0; index < count; index++) next.write(`.git/objects/pack/unknown-${index}`, '');
    const value = session(context, next.root);
    if (count === limits.packDirectoryEntries) assert.deepEqual(value.files.listPacks(), []);
    else assert.throws(() => value.files.listPacks(), { code: 'COMPANY_GIT_RANGE_LIMIT' });
    assert.equal(value.budget.snapshot().openDescriptors, 0);
  }
});

test('short positioned reads consume the full reservation, record actual bytes, and clean up without returning a buffer', context => {
  const { root } = fixture(context), { files, budget } = session(context, root);
  const handle = files.open('src/main.ts', 65536)!, originalRead = fs.readSync;
  context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, length: number, position: number) =>
    originalRead(descriptor, bytes, offset, length - 1, position)) as typeof fs.readSync);
  changed(() => handle.read(0, 8));
  assert.equal(budget.snapshot().readBytesReserved, 8); assert.equal(budget.snapshot().readBytesReturned, 7);
  assert.equal(budget.snapshot().pendingReads, 0); assert.equal(budget.snapshot().openDescriptors, 0);
  assert.equal(budget.snapshot().liveMemoryBytes, 0); assert.deepEqual(files.proof().files[0]!.reads, []);
});

test('read failures and mutations during a read fail closed with fixed errors and release pending resources', context => {
  for (const mutate of [false, true]) {
    const { root } = fixture(context), { files, budget } = session(context, root);
    const handle = files.open('src/main.ts', 65536)!, originalRead = fs.readSync;
    const mocked = context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, length: number, position: number) => {
      if (!mutate) throw new Error(`UNSAFE_NATIVE_ERROR_${root}`);
      const returned = originalRead(descriptor, bytes, offset, length, position);
      fs.appendFileSync(join(root, 'src/main.ts'), 'changed'); return returned;
    }) as typeof fs.readSync);
    changed(() => handle.read(0, 8)); mocked.mock.restore();
    assert.equal(budget.snapshot().readBytesReserved, 8); assert.equal(budget.snapshot().readBytesReturned, mutate ? 8 : 0);
    assert.equal(budget.snapshot().pendingReads, 0); assert.equal(budget.snapshot().openDescriptors, 0);
    assert.equal(budget.snapshot().liveMemoryBytes, 0);
  }
});

test('read boundaries and logical deadline are checked before I/O and without allocating output', context => {
  for (const [offset, length] of [[-1, 1], [0, -1], [source.length, 1], [0.5, 1]] as const) {
    const { root } = fixture(context), { files, budget } = session(context, root), handle = files.open('src/main.ts', 65536)!;
    const before = budget.snapshot().metadataCalls;
    assert.throws(() => handle.read(offset, length), { code: 'COMPANY_GIT_RANGE_INVALID_FILES' });
    assert.equal(budget.snapshot().metadataCalls, before); assert.equal(budget.snapshot().readCalls, 0);
    assert.equal(budget.snapshot().liveMemoryBytes, 0);
  }
  const { root } = fixture(context); let now = 0;
  const { files, budget } = session(context, root, active(), () => now), before = budget.snapshot().metadataCalls;
  now = limits.wallClockMs;
  assert.throws(() => files.open('src/main.ts', 65536), { code: 'COMPANY_GIT_RANGE_TIMEOUT' });
  assert.equal(budget.snapshot().metadataCalls, before); assert.equal(budget.snapshot().openDescriptors, 0);
});

test('two sessions share the request budget while re-reading content in each pass', context => {
  const { root } = fixture(context), budget = active();
  for (const pass of ['inspect', 'verify'] as const) {
    if (pass === 'verify') budget.beginPass(pass, 1);
    const { files } = session(context, root, budget, () => 1), handle = files.open('src/main.ts', 65536)!;
    const result = handle.read(0, source.length); budget.releaseMemory(result.memoryLease);
    files.assertUnchanged(); files.close(); budget.endPass(1);
  }
  assert.equal(budget.snapshot().readBytesReserved, 2 * source.length);
  assert.equal(budget.snapshot().readBytesReturned, 2 * source.length);
  assert.equal(budget.snapshot().passes.inspect.readBytesReserved, source.length);
  assert.equal(budget.snapshot().passes.verify.readBytesReserved, source.length);
});

test('alternate object stores are rejected by presence metadata without opening their contents', context => {
  for (const name of ['alternates', 'http-alternates']) {
    const { root, write } = fixture(context);
    write(`.git/objects/info/${name}`, 'UNREAD_SYNTHETIC_ALTERNATE');
    const budget = active(); let opened = 0;
    const mocked = context.mock.method(fs, 'openSync', () => { opened++; throw new Error('UNEXPECTED_CONTENT_OPEN'); });
    changed(() => createCompanyGitRangeFiles(root, ['src/main.ts'], budget, () => 0)); mocked.mock.restore();
    assert.equal(opened, 0); assert.equal(budget.snapshot().readCalls, 0);
  }
  const { root, write } = fixture(context);
  fs.mkdirSync(join(root, '.git/objects/info'), { recursive: true });
  const { files } = session(context, root);
  assert.ok(files.proof().absentPaths.includes('.git/objects/info/alternates'));
  write('.git/objects/info/alternates', 'APPEARED'); changed(() => files.assertUnchanged());
});

test('every explicit metadata operation and directory read is charged to the common budget', context => {
  const { root, write } = fixture(context);
  write(`.git/objects/pack/${packStem}.idx`, 'index'); write(`.git/objects/pack/${packStem}.pack`, 'pack');
  let calls = 0;
  const lstat = fs.lstatSync, fstat = fs.fstatSync, realpath = fs.realpathSync, open = fs.openSync, opendir = fs.opendirSync;
  context.mock.method(fs, 'lstatSync', ((path: fs.PathLike) => { calls++; return lstat(path); }) as typeof fs.lstatSync);
  context.mock.method(fs, 'fstatSync', ((descriptor: number) => { calls++; return fstat(descriptor); }) as typeof fs.fstatSync);
  context.mock.method(fs, 'realpathSync', ((path: fs.PathLike) => { calls++; return realpath(path); }) as typeof fs.realpathSync);
  context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: number, mode?: fs.Mode) => { calls++; return open(path, flags, mode); }) as typeof fs.openSync);
  context.mock.method(fs, 'opendirSync', ((path: fs.PathLike, options?: fs.OpenDirOptions) => {
    calls++; const directory = opendir(path, options), read = directory.readSync.bind(directory);
    context.mock.method(directory, 'readSync', () => { calls++; return read(); }); return directory;
  }) as typeof fs.opendirSync);
  const { files, budget } = session(context, root), handle = files.open('src/main.ts', 65536)!;
  const bytes = handle.read(0, 1); budget.releaseMemory(bytes.memoryLease);
  files.listPacks(); files.assertUnchanged(); handle.close();
  assert.equal(budget.snapshot().metadataCalls, calls);
  assert.equal(budget.snapshot().openDescriptors, 0);
});

test('the descriptor ceiling is enforced before another open and all issued handles remain safely closeable', context => {
  const { root } = fixture(context), { files, budget } = session(context, root);
  const handles = Array.from({ length: limits.openDescriptors }, () => files.open('src/main.ts', 65536)!);
  assert.equal(budget.snapshot().openDescriptors, limits.openDescriptors);
  assert.throws(() => files.open('src/main.ts', 65536), { code: 'COMPANY_GIT_RANGE_LIMIT' });
  assert.equal(budget.snapshot().openDescriptors, 0);
  for (const handle of handles) handle.close();
  assert.equal(budget.snapshot().peakOpenDescriptors, limits.openDescriptors);
});

test('uncertain file close retains its descriptor charge and never retries a possibly reused descriptor', context => {
  for (const closedBeforeError of [false, true]) {
    const { root } = fixture(context), budget = active(), files = createCompanyGitRangeFiles(root, ['src/main.ts'], budget, () => 0);
    const originalOpen = fs.openSync, originalClose = fs.closeSync;
    let descriptor = -1, attempts = 0;
    const mockedOpen = context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: number, mode?: fs.Mode) => {
      descriptor = originalOpen(path, flags, mode); return descriptor;
    }) as typeof fs.openSync);
    const handle = files.open('src/main.ts', 65536)!; mockedOpen.mock.restore();
    const mockedClose = context.mock.method(fs, 'closeSync', (value: number) => {
      assert.equal(value, descriptor); attempts++;
      if (closedBeforeError) originalClose(value);
      throw new Error('SYNTHETIC_UNCERTAIN_CLOSE');
    });
    try {
      changed(() => handle.close()); changed(() => files.close()); changed(() => handle.close());
      assert.equal(attempts, 1); assert.equal(budget.snapshot().openDescriptors, 1);
      assert.equal(budget.snapshot().phase, 'failed');
    } finally {
      mockedClose.mock.restore(); if (!closedBeforeError) originalClose(descriptor);
    }
  }
});

test('uncertain directory close also retains its charge without reporting successful cleanup', context => {
  const { root, write } = fixture(context);
  write('.git/objects/pack/unknown.keep', '');
  const budget = active(), files = createCompanyGitRangeFiles(root, ['src/main.ts'], budget, () => 0);
  const originalOpen = fs.opendirSync; let attempts = 0, cleanup: (() => void) | undefined;
  const mocked = context.mock.method(fs, 'opendirSync', ((path: fs.PathLike, options?: fs.OpenDirOptions) => {
    const directory = originalOpen(path, options); cleanup = directory.closeSync.bind(directory);
    context.mock.method(directory, 'closeSync', () => { attempts++; throw new Error('SYNTHETIC_DIRECTORY_CLOSE'); });
    return directory;
  }) as typeof fs.opendirSync);
  try {
    changed(() => files.listPacks()); files.close();
    assert.equal(attempts, 1); assert.equal(budget.snapshot().openDescriptors, 1);
    assert.equal(budget.snapshot().phase, 'failed');
  } finally { mocked.mock.restore(); cleanup?.(); }
});
