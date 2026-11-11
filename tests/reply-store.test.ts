import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SqliteReplyStore } from '../src/adapters/sqlite-reply-store.js';
import type { ReplyApprovalRequest, ReplyControl, ReplyPlan } from '../src/domain/reply.js';
import { createReplyPlan, hashReplyPlan, syntheticReplyBody } from '../src/policy/reply-policy.js';

const now = new Date('2026-11-11T00:00:00.000Z');
const ownerId = `os-user:${process.getuid?.()}`;
const atMinutes = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000);
const requestFor = (plan: ReplyPlan, expiresInMinutes = 30): ReplyApprovalRequest => ({
  taskId: plan.taskId, planHash: plan.planHash, expiresInMinutes,
});
const controlFor = (plan: ReplyPlan, kind: ReplyControl['kind'], revision = 2): ReplyControl => ({
  taskId: plan.taskId, eventId: `${plan.taskId}:${kind}:${revision}`, kind, revision,
});

const openStore = async (context: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-reply-store-')));
  await chmod(directory, 0o700);
  const path = join(directory, 'replies.sqlite');
  let store = new SqliteReplyStore(path);
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteReplyStore(path); return store; } };
};

const withDatabase = <T>(path: string, operation: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(path);
  try { return operation(database); } finally { database.close(); }
};

test('답장 계획은 동일 내용만 멱등 생성하고 본문을 별도 테이블과 0600 DB에 보관한다', async (context) => {
  const { store, path } = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now);
  const created = store.create(plan, body, now);
  assert.equal(created.status, 'AWAITING_APPROVAL');
  assert.deepEqual(store.create(plan, body, now), created);
  const changed = { ...plan, fixture: 'not-sent' as const };
  changed.planHash = hashReplyPlan(changed);
  assert.throws(() => store.create(changed, body, now), { code: 'REPLY_TASK_CONFLICT' });
  assert.throws(() => store.create(plan, '본문 변조', now), { code: 'REPLY_INVALID_BODY' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  withDatabase(path, (database) => {
    const row = database.prepare('SELECT payload FROM reply_tasks WHERE task_id = ?').get(plan.taskId);
    assert.equal(String(row?.payload).includes(body), false);
    assert.equal(database.prepare('SELECT body FROM reply_bodies WHERE task_id = ?').get(plan.taskId)?.body, body);
  });
});

test('소유자·TTL·해시 오류와 불완전 수집은 승인과 시도를 만들지 않는다', async (context) => {
  const { store } = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now);
  store.create(plan, body, now);
  for (const expiresInMinutes of [undefined, 0, 61, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => store.approve({ ...requestFor(plan), expiresInMinutes } as ReplyApprovalRequest, ownerId, now),
      { code: 'REPLY_INVALID_APPROVAL' });
  }
  assert.throws(() => store.approve(requestFor(plan), 'os-user:9999999', now), { code: 'REPLY_OWNER_MISMATCH' });
  assert.throws(() => store.approve(requestFor(plan), ownerId, new Date(NaN)), { code: 'REPLY_INVALID_TIME' });
  assert.throws(() => store.approve({ ...requestFor(plan), planHash: 'a'.repeat(64) }, ownerId, now), { code: 'REPLY_PLAN_HASH_MISMATCH' });
  assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, now), { code: 'REPLY_APPROVAL_REQUIRED' });
  assert.equal(store.inspect(plan.taskId, ownerId, now).approvalPage.total, 0);
  for (const fixture of ['incomplete', 'gap'] as const) {
    const input = createReplyPlan(fixture, ownerId, now);
    assert.equal(store.create(input.plan, input.body, now).status, 'BLOCKED');
    assert.throws(() => store.approve(requestFor(input.plan), ownerId, now), { code: 'REPLY_CONTEXT_INVALID' });
    assert.equal(store.inspect(input.plan.taskId, ownerId, now).attemptTotal, 0);
  }
});

test('승인 snapshot은 본문 없이 고정되고 한 번의 승인 소비와 모의 전송만 허용한다', async (context) => {
  const harness = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now);
  harness.store.create(plan, body, now);
  const approval = harness.store.approve(requestFor(plan), ownerId, now);
  assert.deepEqual(approval.planSnapshot, plan);
  assert.equal(JSON.stringify(approval).includes(body), false);
  approval.planSnapshot.bodyHash = 'f'.repeat(64);
  const claim = harness.store.claim(plan.taskId, plan.planHash, ownerId, now);
  assert.equal(claim.body, body);
  assert.equal(claim.attempt.status, 'SENDING');
  assert.equal(harness.store.inspect(plan.taskId, ownerId, now).approvals[0]?.usedAt, now.toISOString());
  harness.store.finish(claim.attempt.attemptId, { status: 'SIMULATED', reason: null, receiptId: `mock:${claim.attempt.attemptId}` }, now);
  const reopened = harness.reopen();
  const snapshot = reopened.inspect(plan.taskId, ownerId, now);
  assert.equal(snapshot.task.status, 'SIMULATED');
  assert.equal(snapshot.attemptTotal, 1);
  assert.equal(JSON.stringify(snapshot.attempts).includes(body), false);
  assert.throws(() => reopened.claim(plan.taskId, plan.planHash, ownerId, now), { code: 'REPLY_ALREADY_ATTEMPTED' });
  assert.throws(() => reopened.approve(requestFor(plan), ownerId, now), { code: 'REPLY_ALREADY_ATTEMPTED' });
});

test('확실한 미전송만 사용한 승인을 유지한 채 새 승인으로 재시도한다', async (context) => {
  const { store } = await openStore(context);
  const { plan, body } = createReplyPlan('not-sent', ownerId, now);
  store.create(plan, body, now);
  const firstApproval = store.approve(requestFor(plan), ownerId, now);
  const first = store.claim(plan.taskId, plan.planHash, ownerId, now);
  store.finish(first.attempt.attemptId, { status: 'NOT_SENT', reason: 'MOCK_NOT_SENT', receiptId: null }, now);
  assert.equal(store.inspect(plan.taskId, ownerId, now).task.status, 'FAILED');
  assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, now), { code: 'REPLY_APPROVAL_REQUIRED' });
  const secondApproval = store.approve(requestFor(plan), ownerId, now);
  assert.notEqual(firstApproval.approvalId, secondApproval.approvalId);
  const second = store.claim(plan.taskId, plan.planHash, ownerId, now);
  assert.notEqual(second.attempt.attemptId, first.attempt.attemptId);
  assert.equal(store.inspect(plan.taskId, ownerId, now, 1).approvals[0]?.usedAt, now.toISOString());
  assert.equal(store.inspect(plan.taskId, ownerId, now).attemptTotal, 2);
});

test('승인 만료를 commit하고 최신 승인 한 건씩 페이지하며 payload 만료를 넘기지 않는다', async (context) => {
  const { store } = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now, { bodyRetentionHours: 1, auditRetentionDays: null });
  store.create(plan, body, now);
  const first = store.approve(requestFor(plan, 1), ownerId, now);
  assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, atMinutes(1)), { code: 'REPLY_APPROVAL_EXPIRED' });
  const expired = store.inspect(plan.taskId, ownerId, atMinutes(1));
  assert.equal(expired.task.status, 'AWAITING_APPROVAL');
  assert.equal(expired.approvals[0]?.revokedAt, atMinutes(1).toISOString());
  const second = store.approve(requestFor(plan, 60), ownerId, atMinutes(1));
  assert.equal(second.expiresAt, plan.expiresAt);
  assert.equal(store.inspect(plan.taskId, ownerId, atMinutes(1)).approvals[0]?.approvalId, second.approvalId);
  const older = store.inspect(plan.taskId, ownerId, atMinutes(1), 1);
  assert.equal(older.approvals[0]?.approvalId, first.approvalId);
  assert.deepEqual(older.approvalPage, { offset: 1, total: 2, nextOffset: null });
  for (const offset of [-1, NaN, Infinity, 0.5]) {
    assert.throws(() => store.inspect(plan.taskId, ownerId, atMinutes(1), offset), { code: 'REPLY_INVALID_APPROVAL_OFFSET' });
  }
});

test('원문·문맥 제어는 멱등이며 오래된 revision은 무시하고 기존 승인은 영구 무효화한다', async (context) => {
  const { store } = await openStore(context);
  for (const kind of ['edited', 'deleted', 'reply', 'gap', 'incomplete', 'expired', 'cancel'] as const) {
    const { plan, body } = createReplyPlan('success', ownerId, now);
    store.create(plan, body, now);
    store.approve(requestFor(plan), ownerId, now);
    const stale = store.control(controlFor(plan, kind === 'cancel' ? 'reply' : kind, 1), ownerId, now);
    assert.equal(stale.status, 'APPROVED');
    assert.equal(stale.generation, 0);
    const event = controlFor(plan, kind);
    const invalidated = store.control(event, ownerId, now);
    assert.equal(invalidated.status, kind === 'cancel' ? 'CANCELLED' : 'BLOCKED');
    assert.equal(invalidated.generation, 1);
    assert.deepEqual(store.control(event, ownerId, now), invalidated);
    assert.throws(() => store.control({ ...event, revision: 3 }, ownerId, now), { code: 'REPLY_CONTROL_CONFLICT' });
    assert.notEqual(store.inspect(plan.taskId, ownerId, now).approvals[0]?.revokedAt, null);
    assert.throws(() => store.approve(requestFor(plan), ownerId, now), { code: 'REPLY_INVALIDATED' });
    assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, now), { code: 'REPLY_INVALIDATED' });
  }
});

test('SENDING 중 문맥 변경과 명시 복구는 UNKNOWN을 보존하며 재시작으로 전송을 재개하지 않는다', async (context) => {
  const harness = await openStore(context);
  for (const invalidate of [false, true]) {
    const { plan, body } = createReplyPlan('success', ownerId, now);
    harness.store.create(plan, body, now);
    harness.store.approve(requestFor(plan), ownerId, now);
    const claim = harness.store.claim(plan.taskId, plan.planHash, ownerId, now);
    let reopened = harness.reopen();
    assert.equal(reopened.inspect(plan.taskId, ownerId, now).task.status, 'SENDING');
    if (invalidate) reopened.control(controlFor(plan, 'edited'), ownerId, now);
    else reopened.recover(plan.taskId, ownerId, now);
    reopened = harness.reopen();
    const snapshot = reopened.inspect(plan.taskId, ownerId, now);
    assert.equal(snapshot.task.status, 'UNKNOWN');
    assert.equal(snapshot.attempts[0]?.status, 'UNKNOWN');
    assert.equal(snapshot.approvals[0]?.usedAt, now.toISOString());
    assert.throws(() => reopened.finish(claim.attempt.attemptId,
      { status: 'SIMULATED', reason: null, receiptId: `mock:${claim.attempt.attemptId}` }, now), { code: 'REPLY_ATTEMPT_ALREADY_FINISHED' });
    assert.throws(() => reopened.approve(requestFor(plan), ownerId, now));
    assert.equal(reopened.inspect(plan.taskId, ownerId, now).attemptTotal, 1);
  }
});

test('소유자 취소는 새 reply 이후에도 source revision과 무관하게 적용하고 문맥 revision을 보존한다', async (context) => {
  const { store } = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now);
  store.create(plan, body, now);
  store.approve(requestFor(plan), ownerId, now);
  store.control(controlFor(plan, 'reply', 2), ownerId, now);
  const event = controlFor(plan, 'cancel', 1);
  const cancelled = store.control(event, ownerId, now);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.contextRevision, 2);
  assert.equal(cancelled.requestRevision, 1);
  assert.equal(cancelled.generation, 2);
  // JSON 입력의 키 순서는 같은 제어 이벤트의 identity에 영향을 주지 않는다.
  assert.deepEqual(store.control({ revision: 1, kind: 'cancel', eventId: event.eventId, taskId: plan.taskId }, ownerId, now), cancelled);
});

test('반복 미전송 이력도 snapshot은 최근 20개 시도와 전체 개수만 반환한다', async (context) => {
  const { store } = await openStore(context);
  const { plan, body } = createReplyPlan('not-sent', ownerId, now);
  store.create(plan, body, now);
  let latestAttemptId = '';
  for (let index = 0; index < 22; index += 1) {
    store.approve(requestFor(plan), ownerId, now);
    const claim = store.claim(plan.taskId, plan.planHash, ownerId, now);
    latestAttemptId = claim.attempt.attemptId;
    store.finish(latestAttemptId, { status: 'NOT_SENT', reason: 'MOCK_NOT_SENT', receiptId: null }, now);
  }
  const snapshot = store.inspect(plan.taskId, ownerId, now);
  assert.equal(snapshot.attemptTotal, 22);
  assert.equal(snapshot.attempts.length, 20);
  assert.equal(snapshot.attempts[0]?.attemptId, latestAttemptId);
  assert.equal(snapshot.approvalPage.total, 22);
  assert.equal(snapshot.approvals.length, 1);
});

test('본문 만료는 payload만 삭제하고 snapshot·시도·이벤트에 본문을 복사하지 않는다', async (context) => {
  const { store, path } = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now, { bodyRetentionHours: 1, auditRetentionDays: null });
  store.create(plan, body, now);
  store.approve(requestFor(plan, 60), ownerId, now);
  assert.deepEqual(store.maintain(atMinutes(60)), { expiredBodies: 1, expiredAudits: 0 });
  const snapshot = store.inspect(plan.taskId, ownerId, atMinutes(60));
  assert.equal(snapshot.body, null);
  assert.equal(snapshot.task.status, 'BLOCKED');
  assert.notEqual(snapshot.approvals[0]?.revokedAt, null);
  assert.equal(JSON.stringify(snapshot).includes(body), false);
  assert.equal(store.create(plan, body, atMinutes(60)).status, 'BLOCKED');
  assert.equal(store.inspect(plan.taskId, ownerId, atMinutes(60)).body, null);
  assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, atMinutes(60)), { code: 'REPLY_PAYLOAD_EXPIRED' });
  withDatabase(path, (database) => {
    for (const table of ['reply_tasks', 'reply_approvals', 'reply_attempts', 'reply_control_events', 'reply_tombstones']) {
      assert.equal(JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all()).includes(body), false);
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM reply_bodies').get()?.count, 0);
  });
});

test('terminal 본문 만료는 감사 보관 시계를 연장하지 않고 tombstone으로 재생성을 막는다', async (context) => {
  const { store } = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now, { bodyRetentionHours: 1, auditRetentionDays: 1 });
  store.create(plan, body, now);
  store.approve(requestFor(plan), ownerId, now);
  const claim = store.claim(plan.taskId, plan.planHash, ownerId, now);
  store.finish(claim.attempt.attemptId, { status: 'SIMULATED', reason: null, receiptId: `mock:${claim.attempt.attemptId}` }, now);
  // 만료 본문 정리가 이전 전송 결과나 마지막 상태 변경 시각을 덮지 않는다.
  assert.deepEqual(store.maintain(atMinutes(60)), { expiredBodies: 1, expiredAudits: 0 });
  assert.equal(store.inspect(plan.taskId, ownerId, atMinutes(60)).task.status, 'SIMULATED');
  assert.equal(store.inspect(plan.taskId, ownerId, atMinutes(60)).task.updatedAt, now.toISOString());
  assert.deepEqual(store.maintain(atMinutes(1439)), { expiredBodies: 0, expiredAudits: 0 });
  assert.deepEqual(store.maintain(atMinutes(1440)), { expiredBodies: 0, expiredAudits: 1 });
  assert.throws(() => store.inspect(plan.taskId, ownerId, atMinutes(1440)), { code: 'REPLY_TASK_NOT_FOUND' });
  assert.throws(() => store.create(plan, body, atMinutes(1440)), { code: 'REPLY_TASK_PURGED' });
});

test('본문·승인 snapshot·task 행 변조는 승인 소비 전에 거부하고 그대로 rollback한다', async (context) => {
  const { store, path } = await openStore(context);
  for (const scenario of ['body', 'approval', 'task']) {
    const { plan, body } = createReplyPlan('success', ownerId, now);
    store.create(plan, body, now);
    const approval = store.approve(requestFor(plan), ownerId, now);
    withDatabase(path, (database) => {
      if (scenario === 'body') database.prepare('UPDATE reply_bodies SET body = ? WHERE task_id = ?').run('changed', plan.taskId);
      if (scenario === 'approval') {
        const changed = { ...approval, planSnapshot: { ...approval.planSnapshot, bodyHash: 'f'.repeat(64) } };
        database.prepare('UPDATE reply_approvals SET payload = ? WHERE approval_id = ?').run(JSON.stringify(changed), approval.approvalId);
      }
      if (scenario === 'task') database.prepare('UPDATE reply_tasks SET status = ? WHERE task_id = ?').run('SENDING', plan.taskId);
      assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, now));
      assert.equal(database.prepare('SELECT used_at FROM reply_approvals WHERE approval_id = ?').get(approval.approvalId)?.used_at, null);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM reply_attempts WHERE task_id = ?').get(plan.taskId)?.count, 0);
    });
  }
});

test('승인과 claim·finish의 중간 SQL 오류는 상태와 소비를 모두 rollback한다', async (context) => {
  const { store, path } = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now);
  store.create(plan, body, now);
  const rejectTransition = (status: string, operation: () => void): void => withDatabase(path, (database) => {
    database.exec(`CREATE TRIGGER reject_transition BEFORE UPDATE ON reply_tasks WHEN NEW.status = '${status}'
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    try { assert.throws(operation); } finally { database.exec('DROP TRIGGER reject_transition'); }
  });
  rejectTransition('APPROVED', () => { store.approve(requestFor(plan), ownerId, now); });
  assert.equal(store.inspect(plan.taskId, ownerId, now).approvalPage.total, 0);
  const approval = store.approve(requestFor(plan), ownerId, now);
  rejectTransition('SENDING', () => { store.claim(plan.taskId, plan.planHash, ownerId, now); });
  const snapshot = store.inspect(plan.taskId, ownerId, now);
  assert.equal(snapshot.task.status, 'APPROVED');
  assert.deepEqual(snapshot.approvals, [approval]);
  assert.equal(snapshot.attemptTotal, 0);
  const claim = store.claim(plan.taskId, plan.planHash, ownerId, now);
  rejectTransition('SIMULATED', () => {
    store.finish(claim.attempt.attemptId, { status: 'SIMULATED', reason: null, receiptId: `mock:${claim.attempt.attemptId}` }, now);
  });
  assert.equal(store.inspect(plan.taskId, ownerId, now).attempts[0]?.status, 'SENDING');
  assert.throws(() => store.finish(claim.attempt.attemptId, { status: 'UNKNOWN', reason: syntheticReplyBody, receiptId: null }, now),
    { code: 'REPLY_INVALID_RESULT' });
});

test('두 store의 동시 claim은 한 번만 승인 소비와 SENDING 생성을 허용한다', { timeout: 20_000 }, async (context) => {
  const { store, path } = await openStore(context);
  const { plan, body } = createReplyPlan('success', ownerId, now);
  store.create(plan, body, now);
  store.approve(requestFor(plan), ownerId, now);
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const ready = new Int32Array(barrier);
  let readyWorkers = 0;
  const workers: Worker[] = [];
  context.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { SqliteReplyStore } from ${JSON.stringify(new URL('../src/adapters/sqlite-reply-store.js', import.meta.url).href)};
    const store = new SqliteReplyStore(workerData.path);
    parentPort.postMessage({ ready: true });
    Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 10000);
    try {
      const claim = store.claim(workerData.taskId, workerData.planHash, workerData.ownerId, new Date(workerData.now));
      parentPort.postMessage({ status: 'started', attemptId: claim.attempt.attemptId });
    } catch (error) { parentPort.postMessage({ status: 'rejected', code: error.code }); }
    finally { store.close(); }
  `;
  const outcomes = await Promise.all([0, 1].map(() => new Promise<{ status: string; code?: string }>((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      workerData: { path, taskId: plan.taskId, planHash: plan.planHash, ownerId, now: now.toISOString(), barrier },
    });
    workers.push(worker);
    worker.on('error', reject);
    worker.on('message', (message: { ready?: boolean; status: string; code?: string }) => {
      if (message.ready) {
        readyWorkers += 1;
        if (readyWorkers === 2) { Atomics.store(ready, 0, 1); Atomics.notify(ready, 0, 2); }
      } else resolve(message);
    });
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
  })));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'started').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected')?.code, 'REPLY_ALREADY_ATTEMPTED');
  const snapshot = store.inspect(plan.taskId, ownerId, now);
  assert.equal(snapshot.attemptTotal, 1);
  assert.equal(snapshot.task.status, 'SENDING');
});

test('DB·부속 파일 링크와 공개 권한을 거부하고 기존 자료를 바꾸지 않는다', async (context) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-reply-path-')));
  await chmod(directory, 0o700);
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const protectedPath = join(directory, 'protected.txt');
  await writeFile(protectedPath, 'synthetic protected data', { mode: 0o600 });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const path = join(directory, `symlink-${suffix || 'main'}.sqlite`);
    await symlink(protectedPath, `${path}${suffix}`);
    assert.throws(() => new SqliteReplyStore(path), { code: 'UNSAFE_RUNTIME_FILE' });
  }
  const hardlinkPath = join(directory, 'hardlink.sqlite');
  await link(protectedPath, hardlinkPath);
  assert.throws(() => new SqliteReplyStore(hardlinkPath), { code: 'UNSAFE_RUNTIME_FILE' });
  const publicPath = join(directory, 'public.sqlite');
  await writeFile(publicPath, '', { mode: 0o644 });
  assert.throws(() => new SqliteReplyStore(publicPath), { code: 'UNSAFE_RUNTIME_FILE' });
  assert.equal((await stat(publicPath)).mode & 0o777, 0o644);
  assert.equal(await readFile(protectedPath, 'utf8'), 'synthetic protected data');
});
