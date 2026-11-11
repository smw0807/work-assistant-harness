import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import type { ReplyWorkerOptions } from '../src/cli/reply.js';
import type { ReplyApproval, ReplyAttempt, ReplySnapshot, ReplyTask } from '../src/domain/reply.js';
import { syntheticReplyBody } from '../src/policy/reply-policy.js';

interface ReplyResult extends Partial<ReplySnapshot> {
  task?: ReplyTask;
  approval?: ReplyApproval;
  attempt?: ReplyAttempt;
  mode: 'mock';
  checks: { name: string; status: string }[];
  maintenance: { expiredBodies: number; expiredAudits: number };
}

const createCli = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-reply-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const execute = (arguments_: string[], environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    resolve('dist/src/cli/main.js'), ...arguments_, '--data-dir', directory,
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 512_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  const run = (arguments_: string[], environment?: Record<string, string>, expectedStatus = 0): ReplyResult => {
    const result = execute(arguments_, environment);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout) as ReplyResult;
    assert.equal(parsed.mode, 'mock');
    assert.equal(parsed.checks.find(({ name }) => name === 'external_message_delivery')?.status, 'not_run');
    assert.equal(parsed.checks.find(({ name }) => name === 'restricted_worker')?.status, 'passed');
    return parsed;
  };
  const reject = (arguments_: string[], codes?: string[]): void => {
    const result = execute(arguments_);
    assert.equal(result.status, 1, result.stdout);
    const code = result.stderr.split('\n')[0] ?? '';
    if (codes) assert.ok(codes.includes(code), result.stderr);
    else assert.match(code, /^REPLY_[A-Z_]+$/);
    assert.equal(result.stdout, '');
  };
  const plan = (fixture = 'success'): ReplyTask => {
    const result = run(['reply-plan', '--fixture', fixture]);
    assert.ok(result.task);
    assert.equal(result.body, syntheticReplyBody);
    return result.task;
  };
  const approve = (task: ReplyTask): ReplyResult => run([
    'reply-approve', '--task', task.taskId, '--plan-hash', task.plan.planHash, '--expires-in-minutes', '30',
  ]);
  const sendArguments = (task: ReplyTask): string[] => ['reply-send', '--task', task.taskId, '--plan-hash', task.plan.planHash];
  return { directory, run, reject, plan, approve, sendArguments };
};

test('답장 CLI는 별도 승인 후 1회만 모의 전송하고 재시작 뒤 본문 없는 감사 기록을 유지한다', async (context) => {
  const cli = await createCli(context);
  const planned = cli.run(['reply-plan'], {
    SLACK_APP_TOKEN: 'SYNTHETIC_NOT_INHERITED', SLACK_WEB_TOKEN: 'SYNTHETIC_NOT_INHERITED',
    HARNESS_OWNER_ID: 'SYNTHETIC_OTHER_OWNER', USER: 'SYNTHETIC_OTHER_OWNER', LOGNAME: 'SYNTHETIC_OTHER_OWNER',
  });
  const task = planned.task;
  assert.ok(task);
  assert.equal(task.status, 'AWAITING_APPROVAL');
  assert.equal(task.plan.ownerId, `os-user:${process.getuid?.()}`);
  assert.deepEqual(task.plan.retention, { bodyRetentionHours: 24, auditRetentionDays: null });
  assert.deepEqual(task.plan.destination, { workspaceId: 'W_LOCAL', channelId: 'C_ALLOWED', threadTs: '1700000000.000001' });
  cli.reject(cli.sendArguments(task));
  const approved = cli.approve(task);
  assert.equal(approved.task?.status, 'APPROVED');
  assert.equal(approved.approval?.usedAt, null);
  assert.equal('body' in approved, false);
  assert.equal(approved.approval?.planSnapshot.planHash, task.plan.planHash);
  assert.equal(JSON.stringify(approved).includes(syntheticReplyBody), false);
  const sent = cli.run(cli.sendArguments(task));
  assert.equal(sent.task?.status, 'SIMULATED');
  assert.equal(sent.attempt?.status, 'SIMULATED');
  assert.match(sent.attempt?.receiptId ?? '', /^mock:/);
  assert.ok(sent.approvals?.[0]?.usedAt);
  assert.equal('body' in sent, false);
  cli.reject(cli.sendArguments(task));
  const reopened = cli.run(['reply-inspect', '--task', task.taskId]);
  assert.equal(reopened.body, syntheticReplyBody);
  assert.equal(reopened.attempts?.length, 1);
  assert.deepEqual(reopened.approvals, sent.approvals);
  const recovered = cli.run(['reply-recover', '--task', task.taskId]);
  assert.equal('body' in recovered, false);
  assert.deepEqual(recovered.attempts, reopened.attempts);
  assert.deepEqual((await readdir(cli.directory)).sort(), ['harness-lock.sqlite', 'replies.sqlite']);
});

test('답장 승인 TTL은 필수 1~60분이고 명령별 추가 입력과 임의 대상을 거부한다', async (context) => {
  const cli = await createCli(context);
  const task = cli.plan();
  const base = ['reply-approve', '--task', task.taskId, '--plan-hash', task.plan.planHash];
  cli.reject(base, ['INVALID_ARGUMENTS']);
  for (const minutes of ['0', '-1', '1.5', '61', '1e1', '30x']) {
    cli.reject([...base, '--expires-in-minutes', minutes], ['INVALID_ARGUMENTS']);
  }
  for (const invalid of [
    ['reply-plan', '--body', 'SYNTHETIC_CUSTOM_BODY'], ['reply-plan', '--channel', 'C_OTHER'],
    ['reply-plan', '--config', 'unused.json'], ['reply-plan', '--events', 'unused.json'],
    ['reply-plan', '--owner-id', 'os-user:999999'], ['reply-plan', '--body-retention-hours', '0'],
    ['reply-plan', '--body-retention-hours', '169'], ['reply-plan', '--audit-retention-days', '0'],
    ['reply-plan', '--audit-retention-days', '3651'], ['reply-plan', '--fixture', 'success', '--fixture', 'gap'],
    ['reply-inspect', '--task', task.taskId, '--approval-offset', '1000000001'],
    ['reply-send', '--task', task.taskId, '--plan-hash', 'not-a-hash'],
    ['reply-cancel', '--task', task.taskId, '--expires-in-minutes', '30'],
    ['reply-prune', '--fixture', 'success'],
  ]) cli.reject(invalid, ['INVALID_ARGUMENTS']);
  assert.equal(cli.run([...base, '--expires-in-minutes', '60']).task?.status, 'APPROVED');
  const emptyPage = cli.run(['reply-inspect', '--task', task.taskId, '--approval-offset', '1']);
  assert.deepEqual(emptyPage.approvals, []);
  assert.deepEqual(emptyPage.approvalPage, { offset: 1, total: 1, nextOffset: null });
  assert.deepEqual(cli.run(['reply-prune']).maintenance, { expiredBodies: 0, expiredAudits: 0 });
});

test('편집·삭제·새 reply·수신 공백·불완전·만료와 소유자 취소는 기존 전송 승인을 무효화한다', async (context) => {
  const cli = await createCli(context);
  for (const event of ['edited', 'deleted', 'reply', 'gap', 'incomplete', 'expired']) {
    const task = cli.plan();
    cli.approve(task);
    const arguments_ = ['reply-invalidate', '--task', task.taskId, '--event', event, '--revision', '2', '--event-id', `synthetic:${event}`];
    const controlled = cli.run(arguments_);
    assert.ok(controlled.task?.invalidatedAt);
    assert.ok(controlled.approvals?.[0]?.revokedAt);
    assert.equal(controlled.approvals?.[0]?.usedAt, null);
    assert.equal('body' in controlled, false);
    assert.deepEqual(cli.run(arguments_).task, controlled.task);
    cli.reject(cli.sendArguments(task));
  }
  const task = cli.plan();
  cli.approve(task);
  const cancelled = cli.run(['reply-cancel', '--task', task.taskId, '--event-id', 'synthetic:cancel']);
  assert.equal(cancelled.task?.status, 'CANCELLED');
  assert.ok(cancelled.approvals?.[0]?.revokedAt);
  cli.reject(cli.sendArguments(task));
  const changedContext = cli.plan();
  cli.run(['reply-invalidate', '--task', changedContext.taskId, '--event', 'reply', '--revision', '2', '--event-id', 'synthetic:reply-before-cancel']);
  const cancelledAfterReply = cli.run(['reply-cancel', '--task', changedContext.taskId]);
  assert.equal(cancelledAfterReply.task?.status, 'CANCELLED');
  assert.equal(cancelledAfterReply.task?.requestRevision, 1);
  assert.equal(cancelledAfterReply.task?.contextRevision, 2);
  for (const fixture of ['incomplete', 'gap']) {
    const blocked = cli.plan(fixture);
    cli.reject(['reply-approve', '--task', blocked.taskId, '--plan-hash', blocked.plan.planHash, '--expires-in-minutes', '30']);
    cli.reject(cli.sendArguments(blocked));
  }
});

test('확실한 미전송과 불확실한 모의 결과를 실패 exit와 함께 출력하고 자동 재시도하지 않는다', async (context) => {
  const cli = await createCli(context);
  for (const [fixture, status, taskStatus] of [['not-sent', 'NOT_SENT', 'FAILED'], ['unknown', 'UNKNOWN', 'UNKNOWN']]) {
    const task = cli.plan(fixture);
    cli.approve(task);
    const attempted = cli.run(cli.sendArguments(task), undefined, 1);
    assert.equal(attempted.attempt?.status, status);
    assert.equal(attempted.task?.status, taskStatus);
    assert.equal('body' in attempted, false);
    const recovered = cli.run(['reply-recover', '--task', task.taskId]);
    assert.equal(recovered.attempts?.length, 1);
    assert.ok(recovered.approvals?.[0]?.usedAt);
    cli.reject(cli.sendArguments(task));
  }
});

test('모든 답장 명령은 전역 lease를 유지하고 DB sidecar symlink와 공개 파일을 거부한다', async (context) => {
  const cli = await createCli(context);
  const task = cli.plan();
  const release = acquireRuntimeLease(cli.directory);
  try {
    for (const command of [
      ['reply-plan'], ['reply-inspect', '--task', task.taskId], ['reply-prune'],
      ['reply-cancel', '--task', task.taskId], ['reply-recover', '--task', task.taskId],
      ['reply-approve', '--task', task.taskId, '--plan-hash', task.plan.planHash, '--expires-in-minutes', '30'],
      cli.sendArguments(task),
      ['reply-invalidate', '--task', task.taskId, '--event', 'gap', '--revision', '2', '--event-id', 'synthetic:lease'],
    ]) cli.reject(command, ['HARNESS_ALREADY_RUNNING']);
  } finally { release(); }
  const outside = join(cli.directory, 'outside-synthetic.txt');
  await writeFile(outside, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = join(cli.directory, `replies.sqlite${suffix}`);
    await symlink(outside, sidecar);
    cli.reject(['reply-prune'], ['UNSAFE_RUNTIME_FILE']);
    await rm(sidecar);
  }
  assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_UNCHANGED');
  await chmod(join(cli.directory, 'replies.sqlite'), 0o644);
  cli.reject(['reply-inspect', '--task', task.taskId], ['REPLY_DATABASE_NOT_PRIVATE']);
  await chmod(join(cli.directory, 'replies.sqlite'), 0o600);
  assert.equal(cli.run(['reply-inspect', '--task', task.taskId]).task?.status, 'AWAITING_APPROVAL');
});

test('답장 worker는 광범위 권한·상속 환경·소유자 위조를 거부하며 파일·child·network 권한을 차단한다', async (context) => {
  const cli = await createCli(context);
  const sourceRoot = await realpath(resolve('.'));
  const options: ReplyWorkerOptions = {
    command: 'reply-prune', sourceRoot, dataDirectory: cli.directory, taskId: randomUUID(),
    planHash: '', fixture: 'success', retention: { bodyRetentionHours: 24, auditRetentionDays: null },
    expiresInMinutes: 1, approvalOffset: 0, eventId: '', event: 'edited', revision: 2,
  };
  const permissions = ['--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${cli.directory}`, `--allow-fs-write=${cli.directory}`];
  const worker = join(sourceRoot, 'dist/src/cli/reply-worker.js');
  for (const extraPermissions of [[], ['--allow-net'], ['--allow-child-process'], [`--allow-fs-write=${sourceRoot}`]]) {
    const environment = extraPermissions.length === 0 ? { SYNTHETIC_TOKEN: 'MUST_NOT_BE_INHERITED' } : {};
    const result = spawnSync(process.execPath, [...permissions, ...extraPermissions, worker, JSON.stringify(options)], {
      encoding: 'utf8', timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /REPLY_UNSAFE_WORKER_(?:PERMISSIONS|ENVIRONMENT)/);
  }
  const outside = await mkdtemp(join(await realpath(tmpdir()), 'harness-reply-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const target = join(outside, 'target.txt');
  await writeFile(target, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  const code = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import net from 'node:net';
    const results = {};
    for (const [key, operation] of [
      ['read', () => readFileSync(${JSON.stringify(target)})],
      ['write', () => writeFileSync(${JSON.stringify(target)}, 'changed')],
      ['child', () => spawnSync(process.execPath, ['--version'])],
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
  const probe = spawnSync(process.execPath, [...permissions, '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 5_000, env: { LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { read: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', child: 'ERR_ACCESS_DENIED', net: 'ERR_ACCESS_DENIED' });
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC_UNCHANGED');
});
