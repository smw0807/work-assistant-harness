import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { LocalBranchWorkerOptions } from '../src/cli/local-branch.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import type { BranchWorkType } from '../src/domain/branch.js';
import type { LocalBranchSnapshot, LocalBranchTask } from '../src/domain/local-branch.js';

interface CliResult extends LocalBranchSnapshot {
  mode: 'local-synthetic';
  checks: { name: string; status: string }[];
}

// 준비 과정에서 동결한 합성 저장소만 test 종료 시 정리한다. 링크는 따라가지 않는다.
const removeFixture = async (directory: string): Promise<void> => {
  const metadata = await lstat(directory);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory)) await removeFixture(join(directory, entry));
  }
  await rm(directory, { recursive: true, force: true });
};

const fileHash = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');

const snapshotFiles = async (root: string): Promise<Record<string, { hash: string; mode: number }>> => {
  const files: Record<string, { hash: string; mode: number }> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory)).sort()) {
      const path = join(directory, entry);
      const metadata = await lstat(path);
      assert.equal(metadata.isSymbolicLink(), false);
      if (metadata.isDirectory()) await visit(path);
      else {
        assert.equal(metadata.isFile(), true);
        files[relative(root, path)] = { hash: await fileHash(path), mode: metadata.mode & 0o777 };
      }
    }
  };
  await visit(root);
  return files;
};

const createCli = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-local-branch-cli-'));
  context.after(() => removeFixture(directory));
  const execute = (arguments_: string[], environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    resolve('dist/src/cli/main.js'), ...arguments_, '--data-dir', directory,
  ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 512_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  const run = (arguments_: string[], expectedStatus = 0, environment?: Record<string, string>): CliResult => {
    const result = execute(arguments_, environment);
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout) as CliResult;
    assert.equal(parsed.mode, 'local-synthetic');
    assert.equal(parsed.checks.find(({ name }) => name === 'restricted_worker')?.status, 'passed');
    for (const name of ['codex_execution', 'git_remote_operations']) {
      assert.equal(parsed.checks.find((check) => check.name === name)?.status, 'not_run');
    }
    assert.equal(result.stdout.includes('SYNTHETIC_DO_NOT_LOG'), false);
    return parsed;
  };
  const reject = (arguments_: string[], codes?: string[]): void => {
    const result = execute(arguments_);
    assert.equal(result.status, 1, result.stdout);
    const code = result.stderr.split('\n')[0] ?? '';
    if (codes) assert.ok(codes.includes(code), result.stderr);
    else assert.match(code, /^LOCAL_BRANCH_[A-Z_]+$/);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('SYNTHETIC_DO_NOT_LOG'), false);
  };
  const plan = (type: BranchWorkType = 'fix'): LocalBranchTask => run(['git-branch-plan', '--type', type]).task;
  const approveArguments = (task: LocalBranchTask, minutes = '30'): string[] => [
    'git-branch-approve', '--task', task.taskId, '--plan-hash', task.plan.planHash, '--expires-in-minutes', minutes,
  ];
  const createArguments = (task: LocalBranchTask): string[] => ['git-branch-create', '--task', task.taskId, '--plan-hash', task.plan.planHash];
  return { directory, execute, run, reject, plan, approveArguments, createArguments };
};

const taskRef = (task: LocalBranchTask): string => join(task.plan.repository.root, 'workspace', '.git', 'refs', 'heads', task.plan.branchName);

test('네 작업 유형은 승인 뒤 실제 ref 한 개만 생성하고 원본·기준·파일·기존 DB를 보존한다', async (context) => {
  const cli = await createCli(context);
  const databases = ['tasks.sqlite', 'slack-inbox.sqlite', 'execution.sqlite', 'replies.sqlite', 'live-replies.sqlite', 'branches.sqlite'];
  for (const database of databases) await writeFile(join(cli.directory, database), 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  const beforeDatabases = await Promise.all(databases.map((file) => fileHash(join(cli.directory, file))));
  for (const workType of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const task = cli.run(['git-branch-plan', '--type', workType], 0, {
      OPENAI_API_KEY: 'SYNTHETIC_DO_NOT_LOG', SLACK_SEND_TOKEN: 'SYNTHETIC_DO_NOT_LOG',
      GIT_CONFIG_GLOBAL: 'SYNTHETIC_DO_NOT_LOG', HARNESS_OWNER_ID: 'os-user:999999',
    }).task;
    assert.equal(task.status, 'AWAITING_APPROVAL');
    assert.equal(task.plan.ownerId, `os-user:${process.getuid?.()}`);
    assert.equal(task.plan.branchName, `${workType}/task-${task.taskId}`);
    assert.equal(task.plan.policy, 'local-synthetic-branch-v1');
    assert.equal(task.plan.repository.root, join(cli.directory, 'git-branches', task.taskId));
    const before = await snapshotFiles(task.plan.repository.root);
    await assert.rejects(readFile(taskRef(task)), { code: 'ENOENT' });
    cli.reject(cli.createArguments(task));
    assert.deepEqual(await snapshotFiles(task.plan.repository.root), before);
    const approved = cli.run(cli.approveArguments(task));
    assert.equal(approved.task.status, 'APPROVED');
    assert.equal(approved.attempt, null);
    assert.equal(approved.approvals[0]?.usedAt, null);
    assert.deepEqual(approved.approvals[0]?.planSnapshot, task.plan);
    await assert.rejects(readFile(taskRef(task)), { code: 'ENOENT' });
    const created = cli.run(cli.createArguments(task));
    assert.equal(created.task.status, 'SUCCEEDED');
    assert.equal(created.attempt?.status, 'SUCCEEDED');
    assert.equal(created.attempt?.before.state, 'absent');
    assert.equal(created.attempt?.after?.state, 'created');
    assert.equal(created.attempt?.after?.branchOid, task.plan.repository.baseCommit);
    assert.equal(created.attempt?.after?.baseOid, task.plan.repository.baseCommit);
    assert.equal(created.attempt?.after?.sourceHash, task.plan.repository.sourceHash);
    assert.equal(created.attempt?.after?.workspaceHash, task.plan.repository.workspaceHash);
    assert.ok(created.approvals[0]?.usedAt);
    assert.equal((await readFile(taskRef(task), 'utf8')).trim(), task.plan.repository.baseCommit);
    const after = await snapshotFiles(task.plan.repository.root);
    const added = relative(task.plan.repository.root, taskRef(task));
    assert.deepEqual(Object.keys(after).filter((path) => !(path in before)), [added]);
    delete after[added];
    assert.deepEqual(after, before);
    cli.reject(cli.createArguments(task));
    cli.reject(cli.approveArguments(task));
    assert.deepEqual(cli.run(['git-branch-inspect', '--task', task.taskId]).attempt, created.attempt);
    assert.deepEqual(cli.run(['git-branch-recover', '--task', task.taskId]).attempt, created.attempt);
    assert.deepEqual(await Promise.all(databases.map((file) => fileHash(join(cli.directory, file)))), beforeDatabases);
  }
  assert.deepEqual((await readdir(cli.directory)).sort(), [...databases, 'git-branches', 'git-branches.sqlite', 'harness-lock.sqlite'].sort());
});

test('로컬 Git CLI는 임의 실행 입력·없는 명령·잘못된 유형과 TTL을 준비 전에 거부한다', async (context) => {
  const cli = await createCli(context);
  for (const command of [
    ['git-branch-plan'], ['git-branch-plan', '--type', 'hotfix'], ['git-branch-plan', '--type', 'feature', '--type', 'fix'],
    ...['--fixture', '--path', '--remote', '--branch-name', '--body', '--command', '--token', '--config', '--owner-id', '--live-enabled', '--pr', '--mr']
      .map((flag) => ['git-branch-plan', '--type', 'fix', flag, 'SYNTHETIC_DO_NOT_LOG']),
  ]) cli.reject(command, ['INVALID_ARGUMENTS']);
  for (const command of ['git-branch-invalidate', 'git-branch-push', 'git-branch-commit', 'git-branch-pr', 'git-branch-mr', 'git-branch-run']) {
    cli.reject([command], ['UNKNOWN_COMMAND']);
  }
  assert.deepEqual(await readdir(cli.directory), []);
  const task = cli.plan();
  const before = await snapshotFiles(task.plan.repository.root);
  const approval = ['git-branch-approve', '--task', task.taskId, '--plan-hash', task.plan.planHash];
  cli.reject(approval, ['INVALID_ARGUMENTS']);
  for (const minutes of ['0', '-1', '1.5', '61', '1e1', '30x']) {
    cli.reject([...approval, '--expires-in-minutes', minutes], ['INVALID_ARGUMENTS']);
  }
  for (const command of [
    ['git-branch-inspect', '--task', '../escaped'],
    ['git-branch-inspect', '--task', task.taskId, '--approval-offset', '1000000001'],
    ['git-branch-create', '--task', task.taskId, '--plan-hash', 'invalid'],
    ['git-branch-cancel', '--task', task.taskId, '--event-id', 'synthetic:cancel'],
    ['git-branch-recover', '--task', task.taskId, '--type', 'feature'],
  ]) cli.reject(command, ['INVALID_ARGUMENTS']);
  cli.reject(['git-branch-approve', '--task', task.taskId, '--plan-hash', 'f'.repeat(64), '--expires-in-minutes', '30']);
  cli.reject(['git-branch-create', '--task', task.taskId, '--plan-hash', 'f'.repeat(64)]);
  assert.deepEqual(await snapshotFiles(task.plan.repository.root), before);
  assert.equal(cli.run(cli.approveArguments(task, '60')).task.status, 'APPROVED');
  cli.reject(cli.approveArguments(task));
  const page = cli.run(['git-branch-inspect', '--task', task.taskId, '--approval-offset', '1']);
  assert.deepEqual(page.approvals, []);
  assert.deepEqual(page.approvalPage, { offset: 1, total: 1, nextOffset: null });
  const short = cli.plan('chore');
  assert.equal(cli.run(cli.approveArguments(short, '1')).task.status, 'APPROVED');
});

test('모의 브랜치 승인을 재사용하지 않고 소유자 취소는 실제 ref를 생성하지 않는다', async (context) => {
  const cli = await createCli(context);
  const mockPlan = cli.execute(['branch-plan', '--type', 'fix']);
  assert.equal(mockPlan.status, 0, mockPlan.stderr);
  const mock = JSON.parse(mockPlan.stdout) as { task: { taskId: string; plan: { planHash: string } } };
  const mockApproval = cli.execute(['branch-approve', '--task', mock.task.taskId, '--plan-hash', mock.task.plan.planHash, '--expires-in-minutes', '30']);
  assert.equal(mockApproval.status, 0, mockApproval.stderr);
  const beforeMock = await fileHash(join(cli.directory, 'branches.sqlite'));
  cli.reject(['git-branch-approve', '--task', mock.task.taskId, '--plan-hash', mock.task.plan.planHash, '--expires-in-minutes', '30']);
  cli.reject(['git-branch-create', '--task', mock.task.taskId, '--plan-hash', mock.task.plan.planHash]);
  assert.equal(await fileHash(join(cli.directory, 'branches.sqlite')), beforeMock);
  for (const approved of [false, true]) {
    const task = cli.plan();
    const before = await snapshotFiles(task.plan.repository.root);
    if (approved) cli.run(cli.approveArguments(task));
    const cancelled = cli.run(['git-branch-cancel', '--task', task.taskId]);
    assert.equal(cancelled.task.status, 'CANCELLED');
    assert.equal(cancelled.attempt, null);
    if (approved) assert.ok(cancelled.approvals[0]?.revokedAt);
    cli.reject(cli.createArguments(task));
    cli.reject(cli.approveArguments(task));
    assert.equal(cli.run(['git-branch-recover', '--task', task.taskId]).task.status, 'CANCELLED');
    assert.deepEqual(await snapshotFiles(task.plan.repository.root), before);
  }
});

test('전역 lease 충돌은 모든 로컬 Git 명령의 DB와 합성 Git 변경을 막는다', async (context) => {
  const cli = await createCli(context);
  const task = cli.plan();
  const beforeDb = await fileHash(join(cli.directory, 'git-branches.sqlite'));
  const beforeFiles = await snapshotFiles(task.plan.repository.root);
  const release = acquireRuntimeLease(cli.directory);
  try {
    for (const command of [
      ['git-branch-plan', '--type', 'feature'], ['git-branch-inspect', '--task', task.taskId],
      cli.approveArguments(task), cli.createArguments(task),
      ['git-branch-cancel', '--task', task.taskId], ['git-branch-recover', '--task', task.taskId],
    ]) cli.reject(command, ['HARNESS_ALREADY_RUNNING']);
  } finally { release(); }
  assert.equal(await fileHash(join(cli.directory, 'git-branches.sqlite')), beforeDb);
  assert.deepEqual(await snapshotFiles(task.plan.repository.root), beforeFiles);
  assert.deepEqual(await readdir(join(cli.directory, 'git-branches')), [task.taskId]);
});

test('로컬 Git DB·sidecar 링크와 공개 파일·디렉터리는 합성 준비 전에 차단한다', async (context) => {
  const cli = await createCli(context);
  const target = join(cli.directory, 'synthetic-unchanged.txt');
  await writeFile(target, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const path = join(cli.directory, `git-branches.sqlite${suffix}`);
    for (const createLink of [symlink, link]) {
      await createLink(target, path);
      cli.reject(['git-branch-plan', '--type', 'fix'], ['UNSAFE_RUNTIME_FILE']);
      await rm(path);
    }
  }
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC_UNCHANGED');
  const task = cli.plan();
  const database = join(cli.directory, 'git-branches.sqlite');
  const before = await fileHash(database);
  await chmod(database, 0o644);
  cli.reject(['git-branch-inspect', '--task', task.taskId], ['LOCAL_BRANCH_DATABASE_NOT_PRIVATE']);
  assert.equal(await fileHash(database), before);
  await chmod(database, 0o600);
  await chmod(cli.directory, 0o755);
  try { cli.reject(['git-branch-plan', '--type', 'fix'], ['DATA_DIRECTORY_NOT_PRIVATE']); }
  finally { await chmod(cli.directory, 0o700); }
  assert.equal(cli.run(['git-branch-inspect', '--task', task.taskId]).task.status, 'AWAITING_APPROVAL');
});

test('로컬 Git worker는 추가 권한·상속 환경·위조 JSON과 숨겨진 옵션을 거부한다', async (context) => {
  const cli = await createCli(context);
  const sourceRoot = await realpath(resolve('.'));
  const options: LocalBranchWorkerOptions = {
    command: 'git-branch-plan', sourceRoot, dataDirectory: cli.directory, taskId: '', planHash: '',
    workType: 'fix', expiresInMinutes: 1, approvalOffset: 0,
  };
  const permissions = ['--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${cli.directory}`, `--allow-fs-write=${cli.directory}`];
  const execute = (flags: string[], value: unknown = options, environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    ...flags, join(sourceRoot, 'dist/src/cli/local-branch-worker.js'), typeof value === 'string' ? value : JSON.stringify(value),
  ], { encoding: 'utf8', timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  for (const flags of [[], [...permissions, '--allow-net'], [...permissions, '--allow-child-process'], [...permissions, '--allow-worker'],
    [...permissions, '--allow-fs-read=/'], [...permissions, `--allow-fs-write=${sourceRoot}`]]) {
    const result = execute(flags);
    assert.equal(result.status, 1, `${flags.join(' ')}\n${result.stdout}`);
    assert.equal(result.stderr.trim().split('\n').at(-1), 'LOCAL_BRANCH_UNSAFE_WORKER_PERMISSIONS');
    assert.equal(result.stdout, '');
  }
  for (const key of ['OPENAI_API_KEY', 'SLACK_SEND_TOKEN', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'HARNESS_OWNER_ID']) {
    const result = execute(permissions, options, { [key]: 'SYNTHETIC_DO_NOT_LOG' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'LOCAL_BRANCH_UNSAFE_WORKER_ENVIRONMENT');
    assert.equal(result.stdout, '');
  }
  for (const value of ['{', null, [], { ...options, token: 'SYNTHETIC_DO_NOT_LOG' },
    { ...options, remote: 'SYNTHETIC_DO_NOT_LOG' }, { ...options, command: 'git-branch-push' },
    { ...options, fixture: 'success' }, { ...options, workType: 'hotfix' }, { ...options, expiresInMinutes: 30 }]) {
    const result = execute(permissions, value);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'INVALID_ARGUMENTS');
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(cli.directory), []);
});

test('로컬 Git worker 권한은 별도 대상 파일·명령·worker·네트워크 접근을 실제로 차단한다', async (context) => {
  const cli = await createCli(context);
  const sourceRoot = await realpath(resolve('.'));
  const outside = await mkdtemp(join(await realpath(tmpdir()), 'harness-local-branch-outside-'));
  context.after(() => removeFixture(outside));
  const target = join(outside, 'target.txt');
  await writeFile(target, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  const before = await fileHash(target);
  const code = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { Worker } from 'node:worker_threads';
    import net from 'node:net';
    const results = {};
    for (const [key, operation] of [
      ['read', () => readFileSync(${JSON.stringify(target)})],
      ['write', () => writeFileSync(${JSON.stringify(target)}, 'changed')],
      ['child', () => spawnSync(process.execPath, ['--version'])],
      ['worker', () => { const worker = new Worker('process.exit(0)', {eval:true}); worker.terminate(); }],
    ]) { try { operation(); results[key] = 'ALLOWED'; } catch(error) { results[key] = error.code; } }
    await new Promise(resolve => {
      try {
        const socket = net.createConnection({host:'127.0.0.1',port:9});
        socket.once('error', error => { results.net = error.code; resolve(); });
        socket.once('connect', () => { results.net = 'ALLOWED'; socket.destroy(); resolve(); });
      } catch(error) { results.net = error.code; resolve(); }
    });
    process.stdout.write(JSON.stringify(results));
  `;
  const probe = spawnSync(process.execPath, [
    '--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${cli.directory}`, `--allow-fs-write=${cli.directory}`,
    '--input-type=module', '-e', code,
  ], { encoding: 'utf8', timeout: 5_000, env: { LANG: 'C.UTF-8', TZ: 'UTC' } });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {
    read: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', child: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED', net: 'ERR_ACCESS_DENIED',
  });
  assert.equal(await fileHash(target), before);
});

test('실제 ref 쓰기 전후 프로세스 중단은 자동 재실행 없이 관찰·명시적 복구한다', async (context) => {
  const cli = await createCli(context);
  for (const checkpoint of ['writing', 'created']) {
    const task = cli.plan('feature');
    cli.run(cli.approveArguments(task));
    const code = `
      import { SqliteLocalBranchStore } from './dist/src/adapters/sqlite-local-branch-store.js';
      import { SyntheticLocalBranchWorkspace } from './dist/src/adapters/local-branch-workspace.js';
      import { LocalBranchService } from './dist/src/application/local-branch.js';
      const store = new SqliteLocalBranchStore(${JSON.stringify(join(cli.directory, 'git-branches.sqlite'))});
      const service = new LocalBranchService(store, new SyntheticLocalBranchWorkspace(${JSON.stringify(cli.directory)}),
        () => new Date(), async phase => {
          if (phase === ${JSON.stringify(checkpoint)}) {
            process.stdout.write('CHECKPOINT\\n');
            await new Promise(() => { setInterval(() => {}, 1000); });
          }
        });
      await service.create(${JSON.stringify(task.taskId)}, ${JSON.stringify(task.plan.planHash)}, 'os-user:' + process.getuid(), new Date());
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: resolve('.'), env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    context.after(() => { child.kill('SIGKILL'); });
    const closed = new Promise<NodeJS.Signals | null>((resolve_) => child.once('close', (_code, signal) => resolve_(signal)));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    await new Promise<void>((resolve_, reject) => {
      const timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${stderr}`)), 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`checkpoint child exited: ${stderr}`)); });
      child.stdout.once('data', (chunk: Buffer) => {
        clearTimeout(timer);
        if (chunk.toString() === 'CHECKPOINT\n') resolve_();
        else reject(new Error('unexpected checkpoint output'));
      });
    });
    assert.equal(child.kill('SIGKILL'), true);
    assert.equal(await closed, 'SIGKILL');
    const beforeRecovery = await snapshotFiles(task.plan.repository.root);
    const interrupted = cli.run(['git-branch-inspect', '--task', task.taskId]);
    assert.equal(interrupted.task.status, 'RUNNING');
    assert.equal(interrupted.attempt?.phase, checkpoint);
    assert.ok(interrupted.approvals[0]?.usedAt);
    cli.reject(cli.createArguments(task));
    const recovered = cli.run(['git-branch-recover', '--task', task.taskId]);
    assert.equal(recovered.task.status, 'INTERRUPTED');
    assert.equal(recovered.attempt?.status, 'INTERRUPTED');
    assert.equal(recovered.attempt?.after?.state, checkpoint === 'created' ? 'created' : 'absent');
    assert.equal(recovered.attempt?.attemptId, interrupted.attempt?.attemptId);
    assert.equal(recovered.approvals[0]?.usedAt, interrupted.approvals[0]?.usedAt);
    assert.deepEqual(await snapshotFiles(task.plan.repository.root), beforeRecovery);
    assert.deepEqual(cli.run(['git-branch-recover', '--task', task.taskId]).attempt, recovered.attempt);
    cli.reject(cli.approveArguments(task));
    cli.reject(cli.createArguments(task));
  }
});
