import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import { SqliteTaskStore } from '../src/adapters/sqlite-task-store.js';
import {
  approvalInvalidationReason, hashChangePlan, validateApprovalRequest,
  type ApprovalContext, type ApprovalRequest,
} from '../src/domain/approval.js';
import type { SlackMessageChange, SlackReceiverConfig } from '../src/domain/slack.js';
import type { ChangePlan, Task } from '../src/domain/types.js';

const now = new Date('2026-11-10T00:00:00.000Z');
const baseCommit = 'a'.repeat(40);
const ownerContext = (overrides: Partial<ApprovalContext> = {}): ApprovalContext => ({
  ownerId: 'uid:501', repoId: 'sample', baseCommit, now, ...overrides,
});

const plannedTask = (): Task => {
  const content = {
    planId: randomUUID(), version: 1, requestRevision: '1700000000.000001', repoId: 'sample', baseCommit,
    objective: '합성 코드의 중복 응답을 수정합니다.', allowedFiles: ['src/orders.service.ts'],
    proposedChanges: ['기존 응답을 반환합니다.'], testCommandIds: [], risks: ['합성 검증만 수행합니다.'],
  };
  return {
    taskId: randomUUID(), eventId: randomUUID(), workspaceId: 'W_LOCAL', channelId: 'C_ALLOWED',
    threadTs: '1700000000.000001', messageTs: '1700000000.000001', requesterId: 'U_REQUESTER',
    requestRevision: content.requestRevision, classification: 'change', status: 'AWAITING_APPROVAL',
    repoId: content.repoId, baseCommit, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    history: ['RECEIVED', 'TRIAGED', 'ANALYZED', 'AWAITING_APPROVAL'],
    plan: { ...content, planHash: hashChangePlan(content) }, failureCode: null,
    report: {
      summary: '합성 보고서', facts: [], hypotheses: [], evidence: [], answerDraft: '', questions: [],
      risks: [], checks: [], nextApproval: '소유자의 검토가 필요합니다.',
    },
  };
};

const approvalRequest = (task: Task, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  taskId: task.taskId, planHash: task.plan?.planHash ?? '', baseCommit: task.baseCommit, expiresInMinutes: 30, ...overrides,
});

const openStore = async (context: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-approval-')));
  await chmod(directory, 0o700);
  const path = join(directory, 'tasks.sqlite');
  let store = new SqliteTaskStore(path);
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    path, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteTaskStore(path); return store; },
  };
};

const replaceStoredTask = (path: string, task: Task): void => {
  const database = new DatabaseSync(path);
  try {
    database.prepare('UPDATE tasks SET status = ?, payload = ? WHERE task_id = ?')
      .run(task.status, JSON.stringify(task), task.taskId);
  } finally { database.close(); }
};

test('계획 해시는 기존 단계 1 JSON 필드 순서와 호환된다', () => {
  const task = plannedTask();
  assert.ok(task.plan);
  const { planHash, ...content } = task.plan;
  assert.equal(planHash, createHash('sha256').update(JSON.stringify(content)).digest('hex'));
  assert.equal(validateApprovalRequest(task, approvalRequest(task), ownerContext()), task.plan);
});

test('정상 승인은 불변 계획 사본과 APPROVED를 저장하지만 소비하지 않는다', async (context) => {
  const { store } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  const approval = store.approve(approvalRequest(task), ownerContext());
  assert.equal(store.find(task.taskId)?.status, 'APPROVED');
  assert.equal(approval.ownerId, 'uid:501');
  assert.equal(approval.executionPolicy, 'approval-only-v1');
  assert.equal(approval.usedAt, null);
  assert.equal(approval.revokedAt, null);
  assert.equal(approval.expiresAt, '2026-11-10T00:30:00.000Z');
  assert.deepEqual(approval.planSnapshot, task.plan);
  approval.planSnapshot.objective = '반환값 변경은 DB를 바꾸지 않습니다.';
  assert.deepEqual(store.listApprovals(task.taskId)[0]?.planSnapshot, task.plan);
  assert.match(store.find(task.taskId)?.report?.nextApproval ?? '', /실행은 비활성화/);
});

test('TTL은 필수 1~1440 정수이며 잘못된 값은 기록을 만들지 않는다', async (context) => {
  const { store } = await openStore(context);
  for (const ttl of [0, -1, 1_441, 1.5, NaN, Infinity, undefined]) {
    const task = plannedTask();
    store.create(task);
    const request = { ...approvalRequest(task), expiresInMinutes: ttl } as ApprovalRequest;
    assert.throws(() => store.approve(request, ownerContext()), { code: 'INVALID_APPROVAL_REQUEST' });
    assert.equal(store.find(task.taskId)?.status, 'AWAITING_APPROVAL');
    assert.equal(store.listApprovals(task.taskId).length, 0);
  }
  const task = plannedTask();
  store.create(task);
  const approval = store.approve(approvalRequest(task, { expiresInMinutes: 1_440 }), ownerContext());
  assert.equal(approval.expiresAt, '2026-11-11T00:00:00.000Z');
});

test('만료 직전은 유지하고 만료 시각부터 무효화하며 재승인은 새 기록을 만든다', async (context) => {
  const { store } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  const approval = store.approve(approvalRequest(task, { expiresInMinutes: 1 }), ownerContext());
  assert.equal(store.reconcileApprovals(new Date(now.getTime() + 59_999)), 0);
  assert.equal(store.find(task.taskId)?.status, 'APPROVED');
  const expiry = new Date(now.getTime() + 60_000);
  assert.equal(store.reconcileApprovals(expiry), 1);
  assert.equal(store.reconcileApprovals(expiry), 0);
  assert.equal(store.find(task.taskId)?.status, 'AWAITING_APPROVAL');
  assert.equal(store.find(task.taskId)?.failureCode, 'APPROVAL_EXPIRED');
  assert.equal(store.listApprovals(task.taskId)[0]?.revokedAt, expiry.toISOString());
  assert.equal(store.listApprovals(task.taskId)[0]?.revocationReason, 'APPROVAL_EXPIRED');
  const renewed = store.approve(approvalRequest(task), ownerContext({ now: expiry }));
  assert.notEqual(renewed.approvalId, approval.approvalId);
  assert.equal(store.listApprovals(task.taskId).length, 2);
});

test('승인 history는 최신순 한 건씩 조회하고 전체 건수와 다음 offset을 제공한다', async (context) => {
  const { store } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  const records = [0, 1, 2].map((index) => store.approve(
    approvalRequest(task, { expiresInMinutes: 1 }), ownerContext({ now: new Date(now.getTime() + index * 60_000) }),
  ));
  const first = store.listApprovalHistory(task.taskId, 0);
  assert.equal(first.approvals.length, 1);
  assert.equal(first.approvals[0]?.approvalId, records[2]?.approvalId);
  assert.deepEqual(first.approvalPage, { offset: 0, total: 3, nextOffset: 1 });
  const second = store.listApprovalHistory(task.taskId, 1);
  assert.equal(second.approvals[0]?.approvalId, records[1]?.approvalId);
  assert.deepEqual(second.approvalPage, { offset: 1, total: 3, nextOffset: 2 });
  const last = store.listApprovalHistory(task.taskId, 2);
  assert.equal(last.approvals[0]?.approvalId, records[0]?.approvalId);
  assert.deepEqual(last.approvalPage, { offset: 2, total: 3, nextOffset: null });
  assert.deepEqual(store.listApprovalHistory(task.taskId, 3), {
    approvals: [], approvalPage: { offset: 3, total: 3, nextOffset: null },
  });
  assert.deepEqual(store.listApprovalHistory(task.taskId, 1_000_000_000), {
    approvals: [], approvalPage: { offset: 1_000_000_000, total: 3, nextOffset: null },
  });
  assert.deepEqual(store.listApprovalHistory('missing', 0), {
    approvals: [], approvalPage: { offset: 0, total: 0, nextOffset: null },
  });
  for (const offset of [-1, 1.5, NaN, Infinity, 1_000_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.listApprovalHistory(task.taskId, offset), { code: 'INVALID_APPROVAL_OFFSET' });
  }
});

test('반복 승인과 다른 소유자 승인·취소를 거부한다', async (context) => {
  const { store } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  store.approve(approvalRequest(task), ownerContext());
  assert.throws(() => store.approve(approvalRequest(task), ownerContext()), { code: 'APPROVAL_ALREADY_EXISTS' });
  assert.throws(() => store.approve(approvalRequest(task), ownerContext({ ownerId: 'uid:502' })), { code: 'APPROVAL_OWNER_MISMATCH' });
  assert.throws(() => store.cancelApproval(task.taskId, 'uid:502', now), { code: 'APPROVAL_OWNER_MISMATCH' });
  assert.equal(store.listApprovals(task.taskId).length, 1);
  assert.equal(store.listApprovals(task.taskId)[0]?.revokedAt, null);
});

test('요청 해시·커밋·저장소·revision과 trusted context 불일치는 승인되지 않는다', async (context) => {
  const { store } = await openStore(context);
  for (const mismatch of ['hash', 'requestCommit', 'contextCommit', 'repo', 'revision', 'planRepo', 'planCommit']) {
    const task = plannedTask();
    const request = approvalRequest(task);
    const approvalContext = ownerContext();
    if (mismatch === 'hash') request.planHash = 'b'.repeat(64);
    if (mismatch === 'requestCommit') request.baseCommit = 'b'.repeat(40);
    if (mismatch === 'contextCommit') approvalContext.baseCommit = 'b'.repeat(40);
    if (mismatch === 'repo') approvalContext.repoId = 'other';
    if (mismatch === 'revision') task.requestRevision = '1700000001.000001';
    if (mismatch === 'planRepo' && task.plan) task.plan.repoId = 'other';
    if (mismatch === 'planCommit' && task.plan) task.plan.baseCommit = 'b'.repeat(40);
    if (task.plan && ['planRepo', 'planCommit'].includes(mismatch)) {
      task.plan.planHash = hashChangePlan(task.plan);
      request.planHash = task.plan.planHash;
    }
    store.create(task);
    assert.throws(() => store.approve(request, approvalContext), {
      code: mismatch === 'hash' ? 'PLAN_HASH_MISMATCH' : 'APPROVAL_CONTEXT_MISMATCH',
    });
    assert.equal(store.listApprovals(task.taskId).length, 0);
    assert.equal(store.find(task.taskId)?.status, 'AWAITING_APPROVAL');
  }
});

test('내용을 바꾼 계획과 알 수 없는 계획 필드는 거부한다', async (context) => {
  const { store } = await openStore(context);
  const tampered = plannedTask();
  assert.ok(tampered.plan);
  tampered.plan.objective = '해시를 갱신하지 않은 변경';
  store.create(tampered);
  assert.throws(() => store.approve(approvalRequest(tampered), ownerContext()), { code: 'PLAN_HASH_MISMATCH' });
  const unknown = plannedTask();
  unknown.plan = { ...unknown.plan, shell: 'untrusted text' } as unknown as ChangePlan;
  store.create(unknown);
  assert.throws(() => store.approve(approvalRequest(unknown), ownerContext()), { code: 'INVALID_CHANGE_PLAN' });
});

test('문의·계획 없음·미승인 대기 상태 외 작업은 승인하지 않는다', async (context) => {
  const { store } = await openStore(context);
  for (const overrides of [{ classification: 'inquiry' }, { plan: null }, { status: 'REPORTED' }]) {
    const task = { ...plannedTask(), ...overrides } as Task;
    const request = approvalRequest(task, { planHash: task.plan?.planHash ?? 'a'.repeat(64) });
    store.create(task);
    assert.throws(() => store.approve(request, ownerContext()), { code: 'TASK_NOT_AWAITING_APPROVAL' });
  }
});

test('create·save를 통한 APPROVED 위조와 승인된 payload 덮어쓰기를 차단한다', async (context) => {
  const { store } = await openStore(context);
  const forged = { ...plannedTask(), status: 'APPROVED' } as Task;
  assert.throws(() => store.create(forged), { code: 'APPROVAL_STATE_MANAGED' });
  const task = plannedTask();
  store.create(task);
  assert.throws(() => store.save({ ...task, status: 'APPROVED' }), { code: 'APPROVAL_STATE_MANAGED' });
  store.approve(approvalRequest(task), ownerContext());
  const approved = store.find(task.taskId);
  assert.ok(approved);
  assert.throws(() => store.save(approved), { code: 'APPROVAL_STATE_MANAGED' });
  assert.throws(() => store.save({ ...approved, status: 'AWAITING_APPROVAL' }), { code: 'APPROVAL_STATE_MANAGED' });
});

test('대기 작업 취소는 계획·보고를 보존하고 반복 호출과 소유자 경계를 지킨다', async (context) => {
  const { store } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  const cancelled = store.cancelApproval(task.taskId, 'uid:501', now);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.failureCode, 'OWNER_CANCELLED');
  assert.deepEqual(cancelled.plan, task.plan);
  assert.equal(cancelled.report?.summary, task.report?.summary);
  assert.equal(store.listApprovals(task.taskId).length, 0);
  assert.deepEqual(store.cancelApproval(task.taskId, 'uid:501', now), cancelled);
  assert.throws(() => store.cancelApproval(task.taskId, 'uid:502', now), { code: 'APPROVAL_OWNER_MISMATCH' });
});

test('승인 후 취소는 같은 transaction에서 revoke하고 audit 사본을 보존한다', async (context) => {
  const { store } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  const approval = store.approve(approvalRequest(task), ownerContext());
  const cancelTime = new Date(now.getTime() + 1_000);
  const cancelled = store.cancelApproval(task.taskId, 'uid:501', cancelTime);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.deepEqual(cancelled.plan, task.plan);
  assert.deepEqual(store.listApprovals(task.taskId)[0], {
    ...approval, revokedAt: cancelTime.toISOString(), revocationReason: 'OWNER_CANCELLED',
  });
  assert.equal(store.reconcileApprovals(cancelTime), 0);
  assert.throws(() => store.approve(approvalRequest(task), ownerContext({ now: cancelTime })), { code: 'TASK_NOT_AWAITING_APPROVAL' });
});

test('소비 표시가 있는 승인과 만료·취소 승인은 순수 검증에서 거부된다', async (context) => {
  const { store } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  const approval = store.approve(approvalRequest(task), ownerContext());
  const approved = store.find(task.taskId);
  assert.ok(approved);
  assert.equal(approvalInvalidationReason(approval, approved, now), null);
  assert.equal(approvalInvalidationReason({ ...approval, usedAt: now.toISOString() }, approved, now), 'APPROVAL_ALREADY_USED');
  assert.equal(approvalInvalidationReason({ ...approval, revokedAt: now.toISOString() }, approved, now), 'APPROVAL_REVOKED');
  assert.equal(approvalInvalidationReason(approval, approved, new Date(approval.expiresAt)), 'APPROVAL_EXPIRED');
  assert.equal(approvalInvalidationReason({ ...approval, executionPolicy: 'unknown' } as never, approved, now), 'APPROVAL_PLAN_MISMATCH');
});

test('계획·revision·커밋·저장소 불일치 및 CANCELLED 복구는 기존 승인을 무효화한다', async (context) => {
  const harness = await openStore(context);
  for (const mismatch of ['objective', 'revision', 'baseCommit', 'repoId', 'missingPlan', 'cancelled']) {
    const task = plannedTask();
    harness.store.create(task);
    const approval = harness.store.approve(approvalRequest(task), ownerContext());
    const changed = harness.store.find(task.taskId);
    assert.ok(changed);
    if (mismatch === 'objective' && changed.plan) changed.plan.objective = '변조된 계획';
    if (mismatch === 'revision') changed.requestRevision = '1700000001.000001';
    if (mismatch === 'baseCommit') changed.baseCommit = 'b'.repeat(40);
    if (mismatch === 'repoId') changed.repoId = 'other';
    if (mismatch === 'missingPlan') changed.plan = null;
    if (mismatch === 'cancelled') { changed.status = 'CANCELLED'; changed.plan = null; }
    replaceStoredTask(harness.path, changed);
    assert.equal(harness.store.reconcileApprovals(now), 1);
    assert.equal(harness.store.find(task.taskId)?.status, mismatch === 'cancelled' ? 'CANCELLED' : 'AWAITING_APPROVAL');
    assert.equal(harness.store.listApprovals(task.taskId)[0]?.revokedAt, now.toISOString());
    assert.deepEqual(harness.store.listApprovals(task.taskId)[0]?.planSnapshot, approval.planSnapshot);
  }
});

test('승인·취소·만료 audit는 재시작 후에도 남고 자동 소비되지 않는다', async (context) => {
  const harness = await openStore(context);
  const task = plannedTask();
  harness.store.create(task);
  const approval = harness.store.approve(approvalRequest(task, { expiresInMinutes: 1 }), ownerContext());
  const reopened = harness.reopen();
  assert.equal(reopened.find(task.taskId)?.status, 'APPROVED');
  assert.deepEqual(reopened.listApprovals(task.taskId), [approval]);
  assert.equal(reopened.recoverInterrupted(), 0);
  reopened.reconcileApprovals(new Date(now.getTime() + 60_000));
  const reopenedAgain = harness.reopen();
  assert.equal(reopenedAgain.find(task.taskId)?.status, 'AWAITING_APPROVAL');
  assert.equal(reopenedAgain.listApprovals(task.taskId)[0]?.usedAt, null);
  assert.equal(reopenedAgain.listApprovals(task.taskId)[0]?.revocationReason, 'APPROVAL_EXPIRED');
});

test('기존 tasks 테이블 DB에 승인 schema를 추가하고 기존 작업을 유지한다', async (context) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-approval-legacy-')));
  await chmod(directory, 0o700);
  const path = join(directory, 'tasks.sqlite');
  const database = new DatabaseSync(path);
  const task = plannedTask();
  database.exec(`CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
    status TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(workspace_id, event_id)
  ) STRICT;`);
  database.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)')
    .run(task.taskId, task.workspaceId, task.eventId, task.status, JSON.stringify(task));
  database.close();
  const store = new SqliteTaskStore(path);
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(store.find(task.taskId), task);
  assert.equal(store.listApprovals(task.taskId).length, 0);
  assert.equal(store.approve(approvalRequest(task), ownerContext()).planHash, task.plan?.planHash);
});

test('task 갱신 실패 시 승인 INSERT도 rollback하며 부분 승인을 남기지 않는다', async (context) => {
  const { store, path } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TRIGGER reject_approval_state BEFORE UPDATE ON tasks
      WHEN NEW.status = 'APPROVED' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    assert.throws(() => store.approve(approvalRequest(task), ownerContext()));
    assert.equal(store.find(task.taskId)?.status, 'AWAITING_APPROVAL');
    assert.equal(store.listApprovals(task.taskId).length, 0);
    database.exec('DROP TRIGGER reject_approval_state');
    store.approve(approvalRequest(task), ownerContext());
    database.exec(`CREATE TRIGGER reject_cancel_state BEFORE UPDATE ON tasks
      WHEN NEW.status = 'CANCELLED' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    assert.throws(() => store.cancelApproval(task.taskId, 'uid:501', now));
    assert.equal(store.find(task.taskId)?.status, 'APPROVED');
    assert.equal(store.listApprovals(task.taskId)[0]?.revokedAt, null);
  } finally { database.close(); }
});

test('활성 승인은 SQLite unique index가 작업별 하나로 제한한다', async (context) => {
  const { store, path } = await openStore(context);
  const task = plannedTask();
  store.create(task);
  const approval = store.approve(approvalRequest(task), ownerContext());
  const database = new DatabaseSync(path);
  try {
    assert.throws(() => database.prepare('INSERT INTO approvals VALUES (?, ?, ?, NULL, NULL, ?)')
      .run(randomUUID(), task.taskId, approval.ownerId, JSON.stringify(approval)));
  } finally { database.close(); }
  assert.equal(store.listApprovals(task.taskId).length, 1);
});

test('Slack 편집·삭제는 동일 transaction에서 승인을 취소하고 계획 audit를 보존한다', async (context) => {
  const { store, path } = await openStore(context);
  const config: SlackReceiverConfig = {
    workspaceId: 'W_LOCAL', channelIds: ['C_ALLOWED'], targetUserId: 'U_OWNER', retentionHours: 24,
    maxPending: 10, thread: { maxMessages: 10, maxPages: 2, maxBytes: 16_384 }, liveReadEnabled: false,
  };
  const inbox = new SqliteSlackInbox(path, config);
  context.after(() => inbox.close());
  for (const kind of ['edited', 'deleted'] as const) {
    const task = plannedTask();
    task.messageTs = kind === 'edited' ? '1700000000.000001' : '1700000005.000001';
    task.threadTs = task.messageTs;
    task.requestRevision = task.messageTs;
    assert.ok(task.plan);
    task.plan.requestRevision = task.requestRevision;
    task.plan.planHash = hashChangePlan(task.plan);
    store.create(task);
    const approval = store.approve(approvalRequest(task), ownerContext());
    const event: SlackMessageChange = {
      kind, workspaceId: task.workspaceId, channelId: task.channelId, eventId: randomUUID(), messageTs: task.messageTs,
      threadTs: task.threadTs, requesterId: task.requesterId, revision: '1700000010.000001',
      text: kind === 'deleted' ? '' : '<@U_OWNER> 변경된 합성 요청', mentionsTarget: kind !== 'deleted',
    };
    inbox.receive(event, now);
    assert.equal(store.find(task.taskId)?.status, 'CANCELLED');
    assert.equal(store.find(task.taskId)?.plan, null);
    assert.equal(store.find(task.taskId)?.report, null);
    const revoked = store.listApprovals(task.taskId)[0];
    assert.equal(revoked?.revocationReason, kind === 'deleted' ? 'REQUEST_DELETED' : 'REQUEST_CHANGED');
    assert.equal(revoked?.revokedAt, now.toISOString());
    assert.deepEqual(revoked?.planSnapshot, approval.planSnapshot);
  }
});
