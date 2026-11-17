import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCompanyGitRangeFiles, type CompanyGitRangeFiles } from '../src/adapters/company-git-range-files.js';
import { CompanyGitRangeBudget, getCompanyGitRangeProfile } from '../src/policy/company-git-range-budget.js';

const limits = getCompanyGitRangeProfile().limits;
const selectedPath = 'src/nested/main.ts';
const source = Buffer.from('export const answer = 42;\n');
const changed = { code: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' };
// These observations match the current parent identity contract; directory timestamps are deliberately separate.
const directoryIdentity = (metadata: fs.Stats) => ({ dev: metadata.dev, ino: metadata.ino, mode: metadata.mode,
  uid: metadata.uid, gid: metadata.gid });
const readDescriptor = (descriptor: number): Buffer => {
  const bytes = Buffer.alloc(source.length);
  assert.equal(fs.readSync(descriptor, bytes, 0, bytes.length, 0), bytes.length);
  return bytes;
};
const fixture = (context: TestContext) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-range-guard-equivalence-')));
  fs.chmodSync(root, 0o700);
  const descriptors: number[] = [], sessions: CompanyGitRangeFiles[] = [];
  context.after(() => {
    try { for (const files of sessions) files.close(); }
    finally {
      try { for (const descriptor of descriptors) fs.closeSync(descriptor); }
      finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  });
  const write = (path: string, content: string | Buffer): void => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(root, path), content, { mode: 0o600 });
  };
  write('.git/HEAD', `${'0'.repeat(40)}\n`);
  write(selectedPath, source);
  // Keep alternate-store absence observations unchanged so each counterexample exercises its intended guard.
  fs.mkdirSync(join(root, '.git/objects/info'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(root, '.git/objects/pack'), { mode: 0o700 });
  const openDescriptor = (path: string, directory = false): number => {
    const descriptor = fs.openSync(join(root, path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      | (directory ? fs.constants.O_DIRECTORY : 0));
    descriptors.push(descriptor);
    return descriptor;
  };
  const session = () => {
    const budget = new CompanyGitRangeBudget(0);
    budget.beginPass('inspect', 0);
    const files = createCompanyGitRangeFiles(root, [selectedPath], budget, () => 0);
    sessions.push(files);
    return { files, budget };
  };
  return { root, write, openDescriptor, session };
};

test('held child directory and file descriptors do not preserve the original path after an ancestor replacement', context => {
  const value = fixture(context), reading = value.session(), guarding = value.session();
  const handle = reading.files.open(selectedPath, source.length)!;
  guarding.files.open(selectedPath, source.length)!.close();
  const baseline = handle.read(0, source.length);
  assert.deepEqual(baseline.bytes, source); reading.budget.releaseMemory(baseline.memoryLease);
  guarding.files.assertUnchanged();
  const directory = value.openDescriptor('src/nested', true), file = value.openDescriptor(selectedPath);
  const beforeDirectory = fs.fstatSync(directory), beforeFile = fs.fstatSync(file);
  const readsBefore = reading.budget.snapshot().readCalls;

  fs.renameSync(join(value.root, 'src'), join(value.root, 'previous-src'));
  value.write(selectedPath, source);

  const afterDirectory = fs.fstatSync(directory), afterFile = fs.fstatSync(file);
  assert.deepEqual(directoryIdentity(afterDirectory), directoryIdentity(beforeDirectory));
  assert.deepEqual(directoryIdentity(afterFile), directoryIdentity(beforeFile));
  assert.deepEqual(readDescriptor(file), source);
  assert.deepEqual(fs.readFileSync(join(value.root, selectedPath)), source);
  assert.notDeepEqual(directoryIdentity(fs.lstatSync(join(value.root, 'src/nested'))), directoryIdentity(beforeDirectory));
  assert.throws(() => handle.read(0, source.length), changed);
  assert.equal(reading.budget.snapshot().readCalls, readsBefore);
  assert.throws(() => guarding.files.assertUnchanged(), changed);
  assert.equal(reading.budget.snapshot().openDescriptors, 0);
  assert.equal(reading.budget.snapshot().liveMemoryBytes, 0);
});

test('unchanged directory identity does not preserve the observed pack inventory when a valid pair appears', context => {
  const value = fixture(context), first = `pack-${'a'.repeat(40)}`, second = `pack-${'b'.repeat(40)}`;
  value.write(`.git/objects/pack/${first}.idx`, 'synthetic-index');
  value.write(`.git/objects/pack/${first}.pack`, 'synthetic-pack');
  const { files, budget } = value.session(), directory = value.openDescriptor('.git/objects/pack', true);
  assert.deepEqual(files.listPacks(), [`${first}.idx`]);
  files.assertUnchanged();
  const before = directoryIdentity(fs.fstatSync(directory));

  value.write(`.git/objects/pack/${second}.idx`, 'synthetic-index');
  value.write(`.git/objects/pack/${second}.pack`, 'synthetic-pack');

  assert.deepEqual(directoryIdentity(fs.fstatSync(directory)), before);
  assert.deepEqual(directoryIdentity(fs.lstatSync(join(value.root, '.git/objects/pack'))), before);
  assert.throws(() => files.assertUnchanged(), changed);
  assert.deepEqual(files.proof().packNames, [`${first}.idx`, `${first}.pack`]);
  assert.equal(budget.snapshot().readCalls, 0);
  assert.equal(budget.snapshot().openDescriptors, 0);
});

test('unchanged parent identity does not preserve an optional file absence observation', context => {
  const value = fixture(context), parent = '.git/objects/ab', absent = `${parent}/${'c'.repeat(38)}`;
  fs.mkdirSync(join(value.root, parent), { mode: 0o700 });
  const { files, budget } = value.session(), directory = value.openDescriptor(parent, true);
  assert.equal(files.open(absent, limits.gitFileBytes, true), undefined);
  assert.ok(files.proof().absentPaths.includes(absent));
  files.assertUnchanged();
  const before = directoryIdentity(fs.fstatSync(directory));

  value.write(absent, 'synthetic-object');

  assert.deepEqual(directoryIdentity(fs.fstatSync(directory)), before);
  assert.deepEqual(directoryIdentity(fs.lstatSync(join(value.root, parent))), before);
  assert.throws(() => files.assertUnchanged(), changed);
  assert.equal(budget.snapshot().readCalls, 0);
  assert.equal(budget.snapshot().openDescriptors, 0);
});

test('held directory and file identities do not reveal a new symlink in their original ancestor path', context => {
  const value = fixture(context), { files, budget } = value.session();
  const handle = files.open(selectedPath, source.length)!;
  files.assertUnchanged();
  const directory = value.openDescriptor('src/nested', true), file = value.openDescriptor(selectedPath);
  const beforeDirectory = directoryIdentity(fs.fstatSync(directory)), beforeFile = directoryIdentity(fs.fstatSync(file));

  fs.renameSync(join(value.root, 'src'), join(value.root, 'previous-src'));
  fs.symlinkSync(join(value.root, 'previous-src'), join(value.root, 'src'));

  assert.equal(fs.lstatSync(join(value.root, 'src')).isSymbolicLink(), true);
  assert.deepEqual(directoryIdentity(fs.fstatSync(directory)), beforeDirectory);
  assert.deepEqual(directoryIdentity(fs.statSync(join(value.root, 'src/nested'))), beforeDirectory);
  assert.deepEqual(directoryIdentity(fs.fstatSync(file)), beforeFile);
  assert.deepEqual(readDescriptor(file), source);
  assert.deepEqual(fs.readFileSync(join(value.root, selectedPath)), source);
  assert.throws(() => handle.read(0, source.length), changed);
  assert.equal(budget.snapshot().readCalls, 0);
  assert.equal(budget.snapshot().openDescriptors, 0);
});
