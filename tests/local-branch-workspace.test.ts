import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import git from 'isomorphic-git';
import { SyntheticLocalBranchWorkspace } from '../src/adapters/local-branch-workspace.js';
import type { BranchWorkType } from '../src/domain/branch.js';
import type { LocalBranchPlan } from '../src/domain/local-branch.js';
import { createLocalBranchPlan, hashLocalBranchPlan } from '../src/policy/local-branch-policy.js';

const now = new Date('2026-11-12T00:00:00.000Z');
const ownerId = `os-user:${process.getuid?.()}`;
const makeWritable = (path: string): void => {
  const metadata = fs.lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  fs.chmodSync(path, 0o700);
  for (const name of fs.readdirSync(path)) makeWritable(join(path, name));
};
const setup = (context: TestContext) => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'harness-local-branch-workspace-')));
  fs.chmodSync(directory, 0o700);
  context.after(() => { makeWritable(directory); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspace = new SyntheticLocalBranchWorkspace(directory);
  const plan = async (workType: BranchWorkType = 'fix'): Promise<LocalBranchPlan> => {
    const taskId = randomUUID();
    const repository = await workspace.prepare(taskId, workType);
    return createLocalBranchPlan(taskId, workType, ownerId, repository, now);
  };
  return { directory, workspace, plan };
};
const snapshotFiles = (root: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const visit = (relative: string): void => {
    const path = relative ? join(root, relative) : root;
    const metadata = fs.lstatSync(path);
    if (metadata.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name);
    else {
      assert.equal(metadata.isFile(), true);
      result[relative] = `${metadata.mode & 0o7777}:${createHash('sha256').update(fs.readFileSync(path)).digest('hex')}`;
    }
  };
  visit('');
  return result;
};
const referencePath = (plan: LocalBranchPlan): string => join(plan.repository.root, 'workspace', '.git', 'refs', 'heads', plan.branchName);
const writeReference = (plan: LocalBranchPlan, content: string): void => {
  const path = referencePath(plan);
  fs.mkdirSync(dirname(path), { mode: 0o700 });
  fs.writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
};
const overwriteFrozenFile = (path: string, content: string | Buffer): void => {
  fs.chmodSync(path, 0o600);
  fs.writeFileSync(path, content);
  fs.chmodSync(path, 0o444);
};
const assertUnsafe = (workspace: SyntheticLocalBranchWorkspace, plan: LocalBranchPlan): void => {
  assert.deepEqual(workspace.observe(plan), { state: 'unsafe', sourceHash: null, workspaceHash: null,
    baseOid: null, branchOid: null, reason: 'LOCAL_BRANCH_UNSAFE_WORKSPACE' });
  assert.throws(() => workspace.createRef(plan), { code: 'LOCAL_BRANCH_UNSAFE_WORKSPACE' });
};

test('네 작업 유형 모두 실제 독립 Git 브랜치 하나만 생성하며 source·main·HEAD·기존 파일을 보존한다', async (context) => {
  const { workspace, plan: createPlan } = setup(context);
  for (const type of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const plan = await createPlan(type);
    const before = snapshotFiles(plan.repository.root);
    assert.equal(workspace.observe(plan).state, 'absent');
    const sourceRoot = join(plan.repository.root, 'source');
    const workRoot = join(plan.repository.root, 'workspace');
    assert.equal(await git.resolveRef({ fs, dir: sourceRoot, ref: 'HEAD' }), plan.repository.baseCommit);
    assert.equal(await git.resolveRef({ fs, dir: workRoot, ref: 'HEAD' }), plan.repository.baseCommit);
    const sourceFiles = snapshotFiles(sourceRoot);
    for (const path of Object.keys(sourceFiles)) {
      const sourceMetadata = fs.statSync(join(sourceRoot, path));
      const workMetadata = fs.statSync(join(workRoot, path));
      assert.notEqual(sourceMetadata.ino, workMetadata.ino);
      assert.equal(sourceMetadata.nlink, 1);
      assert.equal(workMetadata.nlink, 1);
    }
    workspace.createRef(plan);
    assert.equal(await git.resolveRef({ fs, dir: workRoot, ref: plan.branchName }), plan.repository.baseCommit);
    assert.equal(await git.resolveRef({ fs, dir: workRoot, ref: 'HEAD' }), plan.repository.baseCommit);
    assert.deepEqual(await git.listBranches({ fs, dir: sourceRoot }), ['main']);
    assert.equal(fs.readFileSync(join(workRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    const after = snapshotFiles(plan.repository.root);
    const added = `workspace/.git/refs/heads/${plan.branchName}`;
    assert.equal(after[added], `384:${createHash('sha256').update(`${plan.repository.baseCommit}\n`).digest('hex')}`);
    delete after[added];
    assert.deepEqual(after, before);
    assert.deepEqual(workspace.observe(plan), { state: 'created', sourceHash: plan.repository.sourceHash,
      workspaceHash: plan.repository.workspaceHash, baseOid: plan.repository.baseCommit, branchOid: plan.repository.baseCommit, reason: null });
    assert.equal(fs.statSync(sourceRoot).mode & 0o7777, 0o555);
    assert.equal(fs.statSync(workRoot).mode & 0o7777, 0o555);
    assert.equal(fs.statSync(join(workRoot, '.git/refs/heads')).mode & 0o7777, 0o700);
  }
});

test('중복 prepare는 기존 source·작업 영역·소유 manifest를 초기화하지 않는다', async (context) => {
  const { workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  const before = snapshotFiles(plan.repository.root);
  await assert.rejects(workspace.prepare(plan.taskId, plan.workType), { code: 'LOCAL_BRANCH_PREPARE_FAILED' });
  assert.deepEqual(snapshotFiles(plan.repository.root), before);
  assert.equal(workspace.observe(plan).state, 'absent');
});

test('같은 OID의 기존 ref도 재생성하지 않고 잘못된 OID와 부분 ref는 unsafe로 보존한다', async (context) => {
  const { workspace, plan: createPlan } = setup(context);
  const existing = await createPlan();
  writeReference(existing, `${existing.repository.baseCommit}\n`);
  const before = snapshotFiles(existing.repository.root);
  assert.equal(workspace.observe(existing).state, 'created');
  assert.throws(() => workspace.createRef(existing), { code: 'LOCAL_BRANCH_REF_EXISTS' });
  assert.deepEqual(snapshotFiles(existing.repository.root), before);
  for (const content of ['', 'partial', `${'0'.repeat(40)}\n`, `${existing.repository.baseCommit}\nextra`]) {
    const plan = await createPlan();
    writeReference(plan, content);
    assertUnsafe(workspace, plan);
    assert.equal(fs.readFileSync(referencePath(plan), 'utf8'), content);
  }
});

test('생성 중 남은 빈 type 디렉터리는 absent이며 다른 ref·packed-refs·lock 파일은 unsafe다', async (context) => {
  const { workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  fs.mkdirSync(dirname(referencePath(plan)), { mode: 0o700 });
  assert.equal(workspace.observe(plan).state, 'absent');
  workspace.createRef(plan);
  assert.equal(workspace.observe(plan).state, 'created');
  for (const path of ['.git/refs/heads/fix/foreign', '.git/packed-refs', '.git/refs/heads/fix/task.lock']) {
    const changed = await createPlan();
    const target = join(changed.repository.root, 'workspace', path);
    const parent = dirname(target);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
    fs.chmodSync(parent, 0o700);
    fs.writeFileSync(target, 'SYNTHETIC_UNEXPECTED', { flag: 'wx', mode: 0o600 });
    if (parent.endsWith('/.git')) fs.chmodSync(parent, 0o555);
    assertUnsafe(workspace, changed);
  }
});

test('기준 branch·HEAD·Git 객체·index·config 및 source 코드 변조를 거부한다', async (context) => {
  const { workspace, plan: createPlan } = setup(context);
  for (const [side, path] of [
    ['source', 'src/message.mjs'], ['workspace', 'src/message.mjs'], ['source', '.git/HEAD'],
    ['workspace', '.git/HEAD'], ['workspace', '.git/refs/heads/main'], ['workspace', '.git/index'], ['workspace', '.git/config'],
  ]) {
    const plan = await createPlan();
    overwriteFrozenFile(join(plan.repository.root, side!, path!), 'SYNTHETIC_CHANGED');
    assertUnsafe(workspace, plan);
  }
  const changedObject = await createPlan();
  const objectPath = join(changedObject.repository.root, 'workspace', '.git/objects',
    changedObject.repository.baseCommit.slice(0, 2), changedObject.repository.baseCommit.slice(2));
  overwriteFrozenFile(objectPath, Buffer.from('SYNTHETIC_INVALID_OBJECT'));
  assertUnsafe(workspace, changedObject);
});

test('추가 비밀 파일·hook 이름·큰 파일·많은 엔트리를 정적 오류로 차단하고 본문을 출력하지 않는다', async (context) => {
  const { workspace, plan: createPlan } = setup(context);
  for (const unexpected of ['.env', '.git/hooks/post-checkout', '.git/objects/secret-name']) {
    const plan = await createPlan();
    const target = join(plan.repository.root, 'workspace', unexpected);
    const parent = dirname(target);
    const originalMode = fs.statSync(parent).mode & 0o7777;
    fs.chmodSync(parent, 0o700);
    fs.writeFileSync(target, 'SYNTHETIC_SECRET_DO_NOT_READ', { mode: 0o444 });
    fs.chmodSync(parent, originalMode);
    const observed = workspace.observe(plan);
    assert.equal(observed.state, 'unsafe');
    assert.equal(JSON.stringify(observed).includes('SYNTHETIC_SECRET'), false);
    assert.equal(JSON.stringify(observed).includes(unexpected), false);
    assertUnsafe(workspace, plan);
  }
  const large = await createPlan();
  overwriteFrozenFile(join(large.repository.root, 'workspace', 'README.md'), Buffer.alloc(65_537, 65));
  assertUnsafe(workspace, large);
  const crowded = await createPlan();
  const hooks = join(crowded.repository.root, 'workspace', '.git/hooks');
  fs.chmodSync(hooks, 0o700);
  for (let index = 0; index < 65; index += 1) fs.writeFileSync(join(hooks, `secret-${index}`), 'SYNTHETIC', { mode: 0o444 });
  fs.chmodSync(hooks, 0o555);
  assertUnsafe(workspace, crowded);
});

test('source·workspace와 owner manifest의 symlink·hardlink를 따라가지 않는다', async (context) => {
  const { directory, workspace, plan: createPlan } = setup(context);
  const sentinel = join(directory, 'sentinel');
  fs.writeFileSync(sentinel, 'SYNTHETIC_PROTECTED', { mode: 0o444 });
  for (const [path, kind] of [['workspace/README.md', 'symlink'], ['source/README.md', 'hardlink'], ['owner.json', 'symlink']] as const) {
    const plan = await createPlan();
    const target = join(plan.repository.root, path);
    const parent = dirname(target);
    const mode = fs.statSync(parent).mode & 0o7777;
    fs.chmodSync(parent, 0o700);
    fs.unlinkSync(target);
    if (kind === 'symlink') fs.symlinkSync(sentinel, target);
    else fs.linkSync(sentinel, target);
    fs.chmodSync(parent, mode);
    assertUnsafe(workspace, plan);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SYNTHETIC_PROTECTED');
  }
  const directoryLink = await createPlan();
  const heads = join(directoryLink.repository.root, 'workspace/.git/refs/heads');
  fs.symlinkSync(directory, join(heads, 'fix'));
  assertUnsafe(workspace, directoryLink);
});

test('경로 탈출·다른 task 루트·소유 token·base commit 변조와 부모 링크를 거부한다', async (context) => {
  const { directory, workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  const other = await createPlan();
  for (const mutate of [
    (changed: LocalBranchPlan) => { changed.repository.root += '/../outside'; },
    (changed: LocalBranchPlan) => { changed.repository.root = other.repository.root; },
    (changed: LocalBranchPlan) => { changed.repository.ownerToken = '0'.repeat(64); },
    (changed: LocalBranchPlan) => { changed.repository.baseCommit = '0'.repeat(40); },
    (changed: LocalBranchPlan) => { changed.branchName = '../main'; },
    (changed: LocalBranchPlan) => { changed.repository.sourceHash = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    changed.planHash = hashLocalBranchPlan(changed);
    assertUnsafe(workspace, changed);
  }
  const alias = join(directory, 'alias');
  fs.symlinkSync(join(directory, 'git-branches'), alias);
  const changed = structuredClone(plan);
  changed.repository.root = join(alias, plan.taskId);
  changed.planHash = hashLocalBranchPlan(changed);
  assertUnsafe(workspace, changed);
  await assert.rejects(workspace.prepare('../invalid', 'fix'), { code: 'LOCAL_BRANCH_INVALID_PLAN' });
});

test('파일·디렉터리 권한 변경 및 예상 밖 작업 영역 엔트리를 거부한다', async (context) => {
  const { workspace, plan: createPlan } = setup(context);
  for (const [path, mode] of [['source', 0o755], ['workspace/.git/HEAD', 0o600], ['owner.json', 0o644], ['workspace/.git/refs/heads', 0o755]] as const) {
    const plan = await createPlan();
    fs.chmodSync(join(plan.repository.root, path), mode);
    assertUnsafe(workspace, plan);
  }
  const extra = await createPlan();
  fs.writeFileSync(join(extra.repository.root, 'unexpected'), 'SYNTHETIC', { mode: 0o600 });
  assertUnsafe(workspace, extra);
});
