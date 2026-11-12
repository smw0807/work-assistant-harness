import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { BranchWorkerOptions } from '../src/cli/branch.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import type { BranchSnapshot, BranchTask, BranchWorkType } from '../src/domain/branch.js';

interface BranchResult extends BranchSnapshot {
  mode: 'offline';
  checks: { name: string; status: string }[];
}

const createCli = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-branch-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const execute = (arguments_: string[], environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    resolve('dist/src/cli/main.js'), ...arguments_, '--data-dir', directory,
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 512_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  const run = (arguments_: string[], expectedStatus = 0, environment?: Record<string, string>): BranchResult => {
    const result = execute(arguments_, environment);
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout) as BranchResult;
    assert.equal(parsed.mode, 'offline');
    for (const name of ['actual_git_operations', 'codex_execution']) {
      assert.equal(parsed.checks.find((check) => check.name === name)?.status, 'not_run');
    }
    assert.equal(parsed.checks.find(({ name }) => name === 'restricted_worker')?.status, 'passed');
    assert.equal(result.stdout.includes('SYNTHETIC_DO_NOT_LOG'), false);
    return parsed;
  };
  const reject = (arguments_: string[], codes?: string[]): void => {
    const result = execute(arguments_);
    assert.equal(result.status, 1, result.stdout);
    const code = result.stderr.split('\n')[0] ?? '';
    if (codes) assert.ok(codes.includes(code), result.stderr);
    else assert.match(code, /^BRANCH_[A-Z_]+$/);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('SYNTHETIC_DO_NOT_LOG'), false);
  };
  const plan = (type: BranchWorkType = 'feature', fixture = 'success'): BranchTask => run([
    'branch-plan', '--type', type, '--fixture', fixture,
  ]).task;
  const approveArguments = (task: BranchTask, minutes = '30'): string[] => [
    'branch-approve', '--task', task.taskId, '--plan-hash', task.plan.planHash, '--expires-in-minutes', minutes,
  ];
  const simulateArguments = (task: BranchTask): string[] => ['branch-simulate', '--task', task.taskId, '--plan-hash', task.plan.planHash];
  return { directory, execute, run, reject, plan, approveArguments, simulateArguments };
};

const fileHash = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');

test('네 작업 유형은 별도 프로세스 승인·모의 실행 뒤 기록을 유지하고 실제 대상과 기존 DB를 바꾸지 않는다', async (context) => {
  const cli = await createCli(context);
  const outside = await mkdtemp(join(await realpath(tmpdir()), 'harness-branch-target-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(outside, '.git'), { mode: 0o700 });
  await mkdir(join(outside, 'src'), { mode: 0o700 });
  await writeFile(join(outside, '.git', 'HEAD'), 'ref: refs/heads/main\n', { mode: 0o600 });
  await writeFile(join(outside, 'src', 'message.ts'), 'export const message = "SYNTHETIC_UNCHANGED";\n', { mode: 0o600 });
  const databases = ['tasks.sqlite', 'slack-inbox.sqlite', 'execution.sqlite', 'replies.sqlite', 'live-replies.sqlite'];
  for (const database of databases) await writeFile(join(cli.directory, database), 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  const protectedFiles = [join(outside, '.git', 'HEAD'), join(outside, 'src', 'message.ts'), ...databases.map((file) => join(cli.directory, file))];
  const before = await Promise.all(protectedFiles.map(fileHash));
  for (const workType of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const task = cli.run(['branch-plan', '--type', workType], 0, {
      SLACK_SEND_TOKEN: 'SYNTHETIC_DO_NOT_LOG', OPENAI_API_KEY: 'SYNTHETIC_DO_NOT_LOG',
      HARNESS_OWNER_ID: 'os-user:999999', USER: 'SYNTHETIC_OTHER_OWNER', LOGNAME: 'SYNTHETIC_OTHER_OWNER',
    }).task;
    assert.equal(task.status, 'AWAITING_APPROVAL');
    assert.equal(task.plan.ownerId, `os-user:${process.getuid?.()}`);
    assert.equal(task.plan.workType, workType);
    assert.equal(task.plan.branchName, `${workType}/synthetic-${task.taskId}`);
    assert.equal(task.plan.policy, 'synthetic-branch-v1');
    assert.equal(task.plan.operation, 'simulate-branch');
    cli.reject(cli.simulateArguments(task));
    const approved = cli.run(cli.approveArguments(task));
    assert.equal(approved.task.status, 'APPROVED');
    assert.equal(approved.attempt, null);
    assert.equal(approved.approvals[0]?.usedAt, null);
    assert.deepEqual(approved.approvals[0]?.planSnapshot, task.plan);
    const simulated = cli.run(cli.simulateArguments(task));
    assert.equal(simulated.task.status, 'SIMULATED');
    assert.equal(simulated.attempt?.status, 'SIMULATED');
    assert.ok(simulated.attempt.receiptId);
    assert.ok(simulated.approvals[0]?.usedAt);
    cli.reject(cli.simulateArguments(task));
    cli.reject(cli.approveArguments(task));
    const reopened = cli.run(['branch-inspect', '--task', task.taskId]);
    assert.deepEqual(reopened.task, simulated.task);
    assert.deepEqual(reopened.attempt, simulated.attempt);
    assert.deepEqual(reopened.approvals, simulated.approvals);
    const recovered = cli.run(['branch-recover', '--task', task.taskId]);
    assert.deepEqual(recovered.attempt, simulated.attempt);
    assert.deepEqual(await Promise.all(protectedFiles.map(fileHash)), before);
  }
  assert.deepEqual((await readdir(cli.directory)).sort(), [...databases, 'branches.sqlite', 'harness-lock.sqlite'].sort());
  assert.deepEqual((await readdir(outside)).sort(), ['.git', 'src']);
  assert.deepEqual(await readdir(join(outside, '.git')), ['HEAD']);
  assert.deepEqual(await readdir(join(outside, 'src')), ['message.ts']);
});

test('브랜치 CLI는 유형·TTL·식별자 범위를 검사하고 임의 저장소·실행·PR/MR 입력을 저장 전에 거부한다', async (context) => {
  const cli = await createCli(context);
  for (const command of [
    ['branch-plan'], ['branch-plan', '--type', 'hotfix'], ['branch-plan', '--type', 'feature', '--fixture', 'live'],
    ['branch-plan', '--type', 'fix', '--type', 'feature'],
    ...['--body', '--repo', '--path', '--remote', '--command', '--config', '--token', '--live-enabled', '--branch-name', '--owner-id', '--pr', '--mr']
      .map((flag) => ['branch-plan', '--type', 'feature', flag, 'SYNTHETIC_DO_NOT_LOG']),
  ]) cli.reject(command, ['INVALID_ARGUMENTS']);
  for (const command of ['branch-pr', 'branch-mr', 'branch-commit', 'branch-push', 'pr', 'mr', 'commit', 'push']) {
    cli.reject([command], ['UNKNOWN_COMMAND']);
  }
  assert.deepEqual(await readdir(cli.directory), []);
  const task = cli.plan();
  const base = ['branch-approve', '--task', task.taskId, '--plan-hash', task.plan.planHash];
  cli.reject(base, ['INVALID_ARGUMENTS']);
  for (const value of ['0', '-1', '1.5', '61', '1e1', '30x']) {
    cli.reject([...base, '--expires-in-minutes', value], ['INVALID_ARGUMENTS']);
  }
  for (const command of [
    ['branch-inspect', '--task', '../escaped'],
    ['branch-inspect', '--task', task.taskId, '--approval-offset', '1000000001'],
    ['branch-inspect', '--task', task.taskId, '--approval-offset', '-1'],
    ['branch-simulate', '--task', task.taskId, '--plan-hash', 'not-a-hash'],
    ['branch-cancel', '--task', task.taskId, '--event-id', '../escaped'],
    ['branch-cancel', '--task', task.taskId, '--expires-in-minutes', '30'],
    ['branch-recover', '--task', task.taskId, '--fixture', 'success'],
    ['branch-invalidate', '--task', task.taskId, '--event', 'reply', '--revision', '2', '--event-id', 'synthetic:invalid'],
    ['branch-invalidate', '--task', task.taskId, '--event', 'edited', '--revision', '1', '--event-id', 'synthetic:invalid'],
    ['branch-invalidate', '--task', task.taskId, '--event', 'edited', '--revision', '1000000001', '--event-id', 'synthetic:invalid'],
  ]) cli.reject(command, ['INVALID_ARGUMENTS']);
  const unchanged = cli.run(['branch-inspect', '--task', task.taskId]);
  assert.equal(unchanged.task.status, 'AWAITING_APPROVAL');
  assert.deepEqual(unchanged.approvals, []);
  assert.equal(unchanged.attempt, null);
  const approved = cli.run(cli.approveArguments(task, '60'));
  assert.equal(approved.task.status, 'APPROVED');
  cli.reject(cli.approveArguments(task));
  const emptyPage = cli.run(['branch-inspect', '--task', task.taskId, '--approval-offset', '1']);
  assert.deepEqual(emptyPage.approvals, []);
  assert.deepEqual(emptyPage.approvalPage, { offset: 1, total: 1, nextOffset: null });
  const shortTask = cli.plan('fix');
  assert.equal(cli.run(cli.approveArguments(shortTask, '1')).task.status, 'APPROVED');
});

test('편집·삭제·기준과 diff 변경·브랜치 충돌 및 소유자 취소는 승인을 취소하고 중복 이벤트를 보존한다', async (context) => {
  const cli = await createCli(context);
  for (const event of ['edited', 'deleted', 'base-changed', 'diff-changed', 'branch-conflict']) {
    const task = cli.plan();
    cli.run(cli.approveArguments(task));
    const command = ['branch-invalidate', '--task', task.taskId, '--event', event, '--revision', '2', '--event-id', `synthetic:${event}`];
    const invalidated = cli.run(command);
    assert.equal(invalidated.task.status, 'BLOCKED');
    assert.ok(invalidated.task.invalidatedAt);
    assert.ok(invalidated.approvals[0]?.revokedAt);
    assert.equal(invalidated.approvals[0]?.usedAt, null);
    assert.equal(invalidated.attempt, null);
    assert.deepEqual(cli.run(command).task, invalidated.task);
    cli.reject(cli.simulateArguments(task));
    cli.reject(cli.approveArguments(task));
  }
  for (const approved of [false, true]) {
    const task = cli.plan('chore');
    if (approved) cli.run(cli.approveArguments(task));
    const cancelled = cli.run(['branch-cancel', '--task', task.taskId]);
    assert.equal(cancelled.task.status, 'CANCELLED');
    assert.equal(cancelled.attempt, null);
    if (approved) assert.ok(cancelled.approvals[0]?.revokedAt);
    cli.reject(cli.simulateArguments(task));
    assert.equal(cli.run(['branch-recover', '--task', task.taskId]).task.status, 'CANCELLED');
  }
});

test('충돌과 불확실 결과는 실패 exit를 반환하고 동일 작업을 재승인·재시도하지 않는다', async (context) => {
  const cli = await createCli(context);
  for (const [fixture, attemptStatus, taskStatus] of [['collision', 'NOT_CREATED', 'FAILED'], ['unknown', 'UNKNOWN', 'UNKNOWN']]) {
    const task = cli.plan('refactor', fixture);
    cli.run(cli.approveArguments(task));
    const simulated = cli.run(cli.simulateArguments(task), 1);
    assert.equal(simulated.task.status, taskStatus);
    assert.equal(simulated.attempt?.status, attemptStatus);
    assert.ok(simulated.approvals[0]?.usedAt);
    const recovered = cli.run(['branch-recover', '--task', task.taskId]);
    assert.deepEqual(recovered.attempt, simulated.attempt);
    cli.reject(cli.simulateArguments(task));
    cli.reject(cli.approveArguments(task));
  }
  const blocked = cli.plan('fix', 'source-changed');
  assert.equal(blocked.status, 'BLOCKED');
  cli.reject(cli.approveArguments(blocked));
  cli.reject(cli.simulateArguments(blocked));
  assert.equal(cli.run(['branch-inspect', '--task', blocked.taskId]).attempt, null);
});

test('모든 브랜치 명령은 전역 lease 충돌 시 상태와 승인 기록을 변경하지 않는다', async (context) => {
  const cli = await createCli(context);
  const task = cli.plan();
  const before = await fileHash(join(cli.directory, 'branches.sqlite'));
  const release = acquireRuntimeLease(cli.directory);
  try {
    for (const command of [
      ['branch-plan', '--type', 'feature'], ['branch-inspect', '--task', task.taskId],
      cli.approveArguments(task), cli.simulateArguments(task), ['branch-cancel', '--task', task.taskId],
      ['branch-recover', '--task', task.taskId],
      ['branch-invalidate', '--task', task.taskId, '--event', 'edited', '--revision', '2', '--event-id', 'synthetic:lease'],
    ]) cli.reject(command, ['HARNESS_ALREADY_RUNNING']);
  } finally { release(); }
  assert.equal(await fileHash(join(cli.directory, 'branches.sqlite')), before);
  const snapshot = cli.run(['branch-inspect', '--task', task.taskId]);
  assert.equal(snapshot.task.status, 'AWAITING_APPROVAL');
  assert.deepEqual(snapshot.approvals, []);
  assert.equal(snapshot.attempt, null);
});

test('브랜치 DB와 sidecar의 symlink·hardlink 및 공개 파일·디렉터리는 쓰기 전에 거부한다', async (context) => {
  const cli = await createCli(context);
  const target = join(cli.directory, 'synthetic-unchanged.txt');
  await writeFile(target, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = join(cli.directory, `branches.sqlite${suffix}`);
    for (const createLink of [symlink, link]) {
      await createLink(target, file);
      cli.reject(['branch-plan', '--type', 'feature'], ['UNSAFE_RUNTIME_FILE']);
      await rm(file);
    }
  }
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC_UNCHANGED');
  const task = cli.plan();
  const database = join(cli.directory, 'branches.sqlite');
  const before = await fileHash(database);
  await chmod(database, 0o644);
  cli.reject(['branch-inspect', '--task', task.taskId], ['BRANCH_DATABASE_NOT_PRIVATE']);
  assert.equal(await fileHash(database), before);
  await chmod(database, 0o600);
  await chmod(cli.directory, 0o755);
  try { cli.reject(['branch-plan', '--type', 'feature'], ['DATA_DIRECTORY_NOT_PRIVATE']); }
  finally { await chmod(cli.directory, 0o700); }
  assert.equal(cli.run(['branch-inspect', '--task', task.taskId]).task.status, 'AWAITING_APPROVAL');
});

test('브랜치 worker는 넓은 권한·상속 토큰·추가 실행 입력을 거부한다', async (context) => {
  const cli = await createCli(context);
  const sourceRoot = await realpath(resolve('.'));
  const options: BranchWorkerOptions = {
    command: 'branch-plan', sourceRoot, dataDirectory: cli.directory, taskId: '', planHash: '',
    workType: 'feature', fixture: 'success', expiresInMinutes: 1, approvalOffset: 0,
    eventId: '', event: 'edited', revision: 2,
  };
  const permissions = ['--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${cli.directory}`, `--allow-fs-write=${cli.directory}`];
  const execute = (flags: string[], value: object = options, environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    ...flags, join(sourceRoot, 'dist/src/cli/branch-worker.js'), JSON.stringify(value),
  ], { encoding: 'utf8', timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  for (const flags of [[], [...permissions, '--allow-net'], [...permissions, '--allow-child-process'],
    [...permissions, '--allow-worker'], [...permissions, `--allow-fs-write=${sourceRoot}`], [...permissions, '--allow-fs-read=/']]) {
    const result = execute(flags);
    assert.equal(result.status, 1, `${flags.join(' ')}\n${result.stdout}`);
    assert.equal(result.stderr.trim().split('\n').at(-1), 'BRANCH_UNSAFE_WORKER_PERMISSIONS');
    assert.equal(result.stdout, '');
  }
  for (const key of ['SLACK_SEND_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_WEB_TOKEN', 'OPENAI_API_KEY', 'HARNESS_OWNER_ID']) {
    const result = execute(permissions, options, { [key]: 'SYNTHETIC_DO_NOT_LOG' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'BRANCH_UNSAFE_WORKER_ENVIRONMENT');
    assert.equal(result.stdout, '');
  }
  for (const extra of [
    { token: 'SYNTHETIC_DO_NOT_LOG' }, { body: 'SYNTHETIC_DO_NOT_LOG' }, { command: 'branch-push' },
    { remote: 'SYNTHETIC_DO_NOT_LOG' }, { liveEnabled: true }, { workType: 'hotfix' }, { sourceRoot: '/' },
  ]) {
    const result = execute(permissions, { ...options, ...extra });
    assert.equal(result.status, 1);
    assert.match(result.stderr.trim(), /^(?:INVALID_ARGUMENTS|BRANCH_UNSAFE_WORKER_PERMISSIONS)$/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(cli.directory), []);
});

test('브랜치 worker의 실제 Node 권한은 대상 파일·하위 프로세스·worker·네트워크 접근을 차단한다', async (context) => {
  const cli = await createCli(context);
  const sourceRoot = await realpath(resolve('.'));
  const outside = await mkdtemp(join(await realpath(tmpdir()), 'harness-branch-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const target = join(outside, 'target.txt');
  await writeFile(target, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
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
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC_UNCHANGED');
});

test('승인 소비 직후 실제 프로세스 중단은 자동 재개되지 않고 명시적 복구에서 UNKNOWN으로 확정한다', async (context) => {
  const cli = await createCli(context);
  const task = cli.plan();
  cli.run(cli.approveArguments(task));
  const code = `
    import { SqliteBranchStore } from './dist/src/adapters/sqlite-branch-store.js';
    const store = new SqliteBranchStore(${JSON.stringify(join(cli.directory, 'branches.sqlite'))});
    store.claim(${JSON.stringify(task.taskId)}, ${JSON.stringify(task.plan.planHash)}, 'os-user:' + process.getuid(), new Date());
    process.stdout.write('CLAIMED\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: resolve('.'), env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(() => { child.kill('SIGKILL'); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve_) => {
    child.once('close', (exitCode, signal) => resolve_({ code: exitCode, signal }));
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve_, reject) => {
    const timer = setTimeout(() => reject(new Error(`claim child timeout: ${stderr}`)), 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`claim child exited: ${stderr}`)); });
    child.stdout.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      if (chunk.toString() === 'CLAIMED\n') resolve_();
      else reject(new Error('unexpected claim output'));
    });
  });
  assert.equal(child.kill('SIGKILL'), true);
  assert.equal((await closed).signal, 'SIGKILL');
  const interrupted = cli.run(['branch-inspect', '--task', task.taskId]);
  assert.equal(interrupted.task.status, 'SIMULATING');
  assert.equal(interrupted.attempt?.status, 'SIMULATING');
  assert.ok(interrupted.approvals[0]?.usedAt);
  cli.reject(cli.simulateArguments(task));
  const recovered = cli.run(['branch-recover', '--task', task.taskId]);
  assert.equal(recovered.task.status, 'UNKNOWN');
  assert.equal(recovered.attempt?.status, 'UNKNOWN');
  assert.equal(recovered.attempt?.attemptId, interrupted.attempt.attemptId);
  assert.equal(recovered.approvals[0]?.usedAt, interrupted.approvals[0]?.usedAt);
  assert.deepEqual(cli.run(['branch-recover', '--task', task.taskId]).attempt, recovered.attempt);
  cli.reject(cli.approveArguments(task));
  cli.reject(cli.simulateArguments(task));
});
