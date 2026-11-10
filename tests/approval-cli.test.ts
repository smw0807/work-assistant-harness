import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { SqliteTaskStore } from '../src/adapters/sqlite-task-store.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import { hashChangePlan, type ApprovalRecord } from '../src/domain/approval.js';
import type { Task } from '../src/domain/types.js';

interface CliReceipt {
  repository: { root: string; baseCommit: string };
  checks: { name: string; status: string; beforeHash: string; afterHash: string }[];
  receiptPath: string;
  result: {
    created?: number;
    tasks?: { taskId: string; status: string }[];
    task?: Task;
    approval?: ApprovalRecord;
    approvals?: ApprovalRecord[];
    approvalPage?: { offset: number; total: number; nextOffset: number | null };
    recovered: number;
  };
}

const removeSyntheticRepository = async (root: string): Promise<void> => {
  const thaw = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return;
    await chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
    if (metadata.isDirectory()) for (const name of await readdir(path)) await thaw(join(path, name));
  };
  await thaw(root);
  await rm(root, { recursive: true });
};

const createCli = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-approval-cli-test-'));
  const repositories = new Set<string>();
  context.after(async () => {
    for (const root of repositories) await removeSyntheticRepository(root);
    await rm(directory, { recursive: true, force: true });
  });
  const execute = (args: string[], environment: Record<string, string> = {}): string => execFileSync(process.execPath, [
    resolve('dist/src/cli/main.js'), ...args, '--data-dir', directory,
  ], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 256_000,
    env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = (args: string[], environment?: Record<string, string>): CliReceipt => {
    const receipt = JSON.parse(execute(args, environment)) as CliReceipt;
    repositories.add(receipt.repository.root);
    assert.match(receipt.repository.baseCommit, /^[a-f0-9]{40}$/);
    assert.deepEqual(receipt.checks.map(({ name, status }) => ({ name, status })), [
      { name: 'target_repository_unchanged', status: 'passed' },
    ]);
    assert.equal(receipt.checks[0]?.beforeHash, receipt.checks[0]?.afterHash);
    return receipt;
  };
  const reject = (args: string[], codes: string[]): void => {
    assert.throws(() => execute(args), (error: unknown) => {
      if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') return false;
      assert.ok(codes.includes(error.stderr.split('\n')[0] ?? ''), error.stderr);
      return true;
    });
  };
  const createTask = (scenario: 'change' | 'inquiry'): Task => {
    const replay = run(['replay', '--fixture', scenario]);
    assert.equal(replay.result.created, 1);
    const taskId = replay.result.tasks?.[0]?.taskId;
    assert.ok(taskId);
    const task = run(['inspect', taskId]).result.task;
    assert.ok(task);
    return task;
  };
  return { directory, run, reject, createTask };
};

const approvalArguments = (task: Task, minutes = '37'): string[] => {
  assert.ok(task.plan);
  return [
    'approve', task.taskId, '--plan-hash', task.plan.planHash,
    '--base-commit', task.plan.baseCommit, '--expires-in-minutes', minutes,
  ];
};

const differentHash = (hash: string): string => `${hash.startsWith('a') ? 'b' : 'a'}${hash.slice(1)}`;
const reportContents = (report: Task['report']) => report ? { ...report, nextApproval: '' } : null;

test('제한 worker CLI는 표시된 계획을 승인하고 재시작·보고서 복구·취소 후에도 감사 기록을 보존한다', async (context) => {
  const cli = await createCli(context);
  const initial = cli.createTask('change');
  assert.equal(initial.status, 'AWAITING_APPROVAL');
  const approved = cli.run(approvalArguments(initial), {
    USER: 'SYNTHETIC_OTHER_USER', LOGNAME: 'SYNTHETIC_OTHER_USER', HARNESS_OWNER_ID: 'U_SYNTHETIC_ENV',
  });
  const approval = approved.result.approval;
  assert.ok(approval);
  assert.equal(approved.result.task?.status, 'APPROVED');
  assert.equal(approval.ownerId, `os-user:${process.getuid?.()}`);
  assert.equal(approval.taskId, initial.taskId);
  assert.equal(approval.repoId, initial.repoId);
  assert.equal(approval.planHash, initial.plan?.planHash);
  assert.equal(approval.baseCommit, initial.baseCommit);
  assert.equal(approval.requestRevision, initial.requestRevision);
  assert.equal(approval.executionPolicy, 'approval-only-v1');
  assert.equal(approval.usedAt, null);
  assert.equal(approval.revokedAt, null);
  assert.deepEqual(approval.planSnapshot, initial.plan);
  assert.deepEqual(reportContents(approved.result.task?.report ?? null), reportContents(initial.report));
  assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), 37 * 60_000);
  assert.deepEqual(approved.result.approvals, [approval]);
  assert.deepEqual(approved.result.approvalPage, { offset: 0, total: 1, nextOffset: null });
  assert.deepEqual(cli.run(['inspect', initial.taskId]).result.approvals, [approval]);
  const beyondHistory = cli.run(['inspect', initial.taskId, '--approval-offset', '1']);
  assert.equal(beyondHistory.result.task?.status, 'APPROVED');
  assert.deepEqual(beyondHistory.result.approvals, []);
  assert.deepEqual(beyondHistory.result.approvalPage, { offset: 1, total: 1, nextOffset: null });

  const reportPath = join(cli.directory, 'reports', `${initial.taskId}.json`);
  await rm(reportPath);
  const restored = cli.run(['inspect', initial.taskId]);
  assert.equal(restored.result.recovered, 0);
  assert.equal(restored.result.task?.status, 'APPROVED');
  assert.deepEqual(restored.result.approvals, [approval]);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), restored.result.task);

  const cancelled = cli.run(['cancel', initial.taskId]);
  assert.equal(cancelled.result.task?.status, 'CANCELLED');
  assert.deepEqual(cancelled.result.task?.plan, initial.plan);
  assert.deepEqual(reportContents(cancelled.result.task?.report ?? null), reportContents(initial.report));
  assert.deepEqual(cancelled.result.approvalPage, { offset: 0, total: 1, nextOffset: null });
  const revoked = cancelled.result.approvals?.[0];
  assert.ok(revoked);
  assert.equal(revoked.approvalId, approval.approvalId);
  assert.ok(revoked.revokedAt && Number.isFinite(Date.parse(revoked.revokedAt)));
  assert.equal(revoked.revocationReason, 'OWNER_CANCELLED');
  assert.equal(revoked.usedAt, null);
  assert.deepEqual(revoked.planSnapshot, initial.plan);
  await rm(reportPath);
  const reopened = cli.run(['inspect', initial.taskId]);
  assert.deepEqual(reopened.result.task, cancelled.result.task);
  assert.deepEqual(reopened.result.approvals, cancelled.result.approvals);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), cancelled.result.task);
});

test('CLI는 계획 해시·기준 커밋 불일치와 중복 승인을 거부한다', async (context) => {
  const cli = await createCli(context);
  const initial = cli.createTask('change');
  assert.ok(initial.plan);
  const wrongHash = approvalArguments(initial);
  wrongHash[3] = differentHash(initial.plan.planHash);
  cli.reject(wrongHash, ['PLAN_HASH_MISMATCH']);
  const wrongCommit = approvalArguments(initial);
  wrongCommit[5] = differentHash(initial.baseCommit);
  cli.reject(wrongCommit, ['APPROVAL_CONTEXT_MISMATCH']);
  const unchanged = cli.run(['inspect', initial.taskId]);
  assert.deepEqual(unchanged.result.task, initial);
  assert.deepEqual(unchanged.result.approvals, []);
  const approved = cli.run(approvalArguments(initial));
  cli.reject(approvalArguments(initial), ['APPROVAL_ALREADY_EXISTS']);
  const reopened = cli.run(['inspect', initial.taskId]);
  assert.deepEqual(reopened.result.task, approved.result.task);
  assert.deepEqual(reopened.result.approvals, approved.result.approvals);
});

test('CLI는 누락·잘못된 TTL과 승인에 무관한 옵션·소유자 주입을 거부한다', async (context) => {
  const cli = await createCli(context);
  const initial = cli.createTask('change');
  const valid = approvalArguments(initial);
  const invalidHash = [...valid];
  invalidHash[3] = 'not-a-plan-hash';
  const invalidCommit = [...valid];
  invalidCommit[5] = 'not-a-base-commit';
  const invalidApprovalRequests = [
    valid.slice(0, -2),
    invalidHash,
    invalidCommit,
    ...['0', '-1', '1.5', '1441', '1e2', '30x'].map((minutes) => approvalArguments(initial, minutes)),
  ];
  for (const args of invalidApprovalRequests) cli.reject(args, ['INVALID_APPROVAL_REQUEST']);
  const invalidOptions = [
    [...valid, '--owner-id', 'U_SYNTHETIC_ARGUMENT'],
    [...valid, '--fixture', 'change'],
    [...valid, '--events', 'unused.json'],
    ['cancel', initial.taskId, '--plan-hash', initial.plan?.planHash ?? ''],
    ['cancel', initial.taskId, '--expires-in-minutes', '30'],
    [...valid, '--approval-offset', '0'],
    ['cancel', initial.taskId, '--approval-offset', '0'],
    ['replay', '--fixture', 'change', '--approval-offset', '0'],
    ['list', '--approval-offset', '0'],
    ['inspect', initial.taskId, '--approval-offset'],
  ];
  for (const args of invalidOptions) cli.reject(args, ['INVALID_ARGUMENTS']);
  for (const offset of ['-1', '1.5', '1000000001', '1e2', 'unused']) {
    cli.reject(['inspect', initial.taskId, '--approval-offset', offset], ['INVALID_APPROVAL_OFFSET']);
  }
  const unchanged = cli.run(['inspect', initial.taskId]);
  assert.deepEqual(unchanged.result.task, initial);
  assert.deepEqual(unchanged.result.approvals, []);
});

test('CLI는 변경 계획이 없는 문의의 승인·취소를 거부하고 승인 대기 변경은 취소한다', async (context) => {
  const cli = await createCli(context);
  const inquiry = cli.createTask('inquiry');
  cli.reject([
    'approve', inquiry.taskId, '--plan-hash', 'a'.repeat(64),
    '--base-commit', inquiry.baseCommit, '--expires-in-minutes', '30',
  ], ['TASK_NOT_AWAITING_APPROVAL']);
  cli.reject(['cancel', inquiry.taskId], ['TASK_NOT_CANCELLABLE']);
  assert.deepEqual(cli.run(['inspect', inquiry.taskId]).result.task, inquiry);
  const change = cli.createTask('change');
  const cancelled = cli.run(['cancel', change.taskId]);
  assert.equal(cancelled.result.task?.status, 'CANCELLED');
  assert.deepEqual(cancelled.result.task?.plan, change.plan);
  assert.deepEqual(reportContents(cancelled.result.task?.report ?? null), reportContents(change.report));
  assert.deepEqual(cancelled.result.approvals, []);
});

test('같은 런타임의 lease가 있으면 승인·취소를 거부한다', async (context) => {
  const cli = await createCli(context);
  const initial = cli.createTask('change');
  const releaseLease = acquireRuntimeLease(cli.directory);
  try {
    cli.reject(approvalArguments(initial), ['HARNESS_ALREADY_RUNNING']);
    cli.reject(['cancel', initial.taskId], ['HARNESS_ALREADY_RUNNING']);
  } finally {
    releaseLease();
  }
  const unchanged = cli.run(['inspect', initial.taskId]);
  assert.deepEqual(unchanged.result.task, initial);
  assert.deepEqual(unchanged.result.approvals, []);
});

test('승인 뒤에도 run은 미구현이며 승인·대상 파일·런타임 파일을 바꾸지 않는다', async (context) => {
  const cli = await createCli(context);
  const initial = cli.createTask('change');
  const approved = cli.run(approvalArguments(initial));
  const targetBefore = await hashRepository(approved.repository.root);
  const runtimeBefore = await hashRepository(cli.directory);
  cli.reject(['run', initial.taskId], ['UNKNOWN_COMMAND']);
  assert.equal(await hashRepository(approved.repository.root), targetBefore);
  assert.equal(await hashRepository(cli.directory), runtimeBefore);
  const reopened = cli.run(['inspect', initial.taskId]);
  assert.equal(reopened.result.task?.status, 'APPROVED');
  assert.equal(reopened.result.approvals?.[0]?.usedAt, null);
  assert.deepEqual(reopened.result.approvals, approved.result.approvals);
});

test('누적된 다국어 승인 이력이 출력 한도를 넘어도 inspect는 한 페이지씩 조회한다', async (context) => {
  const cli = await createCli(context);
  const task = cli.createTask('change');
  assert.ok(task.plan);
  task.plan.objective = '가'.repeat(12_000);
  task.plan.planHash = hashChangePlan(task.plan);
  const store = new SqliteTaskStore(join(cli.directory, 'tasks.sqlite'));
  const count = 10;
  const firstCreatedAt = Date.now() - (count - 1) * 60_000;
  const approvalIds: string[] = [];
  try {
    store.save(task);
    for (let index = 0; index < count; index += 1) {
      const approval = store.approve({
        taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit, expiresInMinutes: 1,
      }, {
        ownerId: `os-user:${process.getuid?.()}`, repoId: task.repoId, baseCommit: task.baseCommit,
        now: new Date(firstCreatedAt + index * 60_000),
      });
      approvalIds.push(approval.approvalId);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(store.listApprovals(task.taskId))) > 256_000);
  } finally {
    store.close();
  }
  const latest = cli.run(['inspect', task.taskId]);
  assert.equal(latest.result.task?.status, 'APPROVED');
  assert.equal(latest.result.approvals?.length, 1);
  assert.equal(latest.result.approvals?.[0]?.approvalId, approvalIds.at(-1));
  assert.deepEqual(latest.result.approvalPage, { offset: 0, total: count, nextOffset: 1 });
  const oldest = cli.run(['inspect', task.taskId, '--approval-offset', String(count - 1)]);
  assert.equal(oldest.result.approvals?.[0]?.approvalId, approvalIds[0]);
  assert.deepEqual(oldest.result.approvalPage, { offset: count - 1, total: count, nextOffset: null });
});
