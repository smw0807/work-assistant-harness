import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { LocalReportSink } from '../src/adapters/local-report-sink.js';
import { SqliteTaskStore } from '../src/adapters/sqlite-task-store.js';
import { LocalApprovalService } from '../src/application/approve.js';
import { hashChangePlan } from '../src/domain/approval.js';
import type { Task } from '../src/domain/types.js';

const now = new Date('2030-01-01T00:00:00Z');
const baseCommit = 'a'.repeat(40);
const ownerId = 'os-user:501';

const createFixture = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'approval-report-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let store = new SqliteTaskStore(databasePath);
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const content = {
    planId: randomUUID(), version: 1, requestRevision: '1700000000.000001', repoId: 'sample',
    baseCommit, objective: '합성 변경 계획', allowedFiles: ['src/example.ts'],
    proposedChanges: ['합성 반환값 변경'], testCommandIds: [], risks: [],
  };
  const task: Task = {
    taskId: randomUUID(), eventId: randomUUID(), workspaceId: 'W_LOCAL', channelId: 'C_ALLOWED',
    threadTs: content.requestRevision, messageTs: content.requestRevision, requesterId: 'U_REQUESTER',
    requestRevision: content.requestRevision, classification: 'change', status: 'AWAITING_APPROVAL',
    repoId: content.repoId, baseCommit, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    history: ['RECEIVED', 'TRIAGED', 'ANALYZED', 'AWAITING_APPROVAL'], failureCode: null,
    plan: { ...content, planHash: hashChangePlan(content) },
    report: {
      summary: '합성 변경 계획', facts: [], hypotheses: [], evidence: [], answerDraft: '',
      questions: [], risks: [], checks: [], nextApproval: '로컬 승인 대기',
    },
  };
  store.create(task);
  const request = { taskId: task.taskId, planHash: task.plan!.planHash, baseCommit, expiresInMinutes: 30 };
  const approvalContext = { ownerId, repoId: task.repoId, baseCommit, now };
  const reporter = new LocalReportSink(join(directory, 'reports'));
  const failingReporter = { write: async (): Promise<string> => { throw new Error('SYNTHETIC_REPORT_FAILURE'); } };
  return {
    task, request, approvalContext, reporter, failingReporter, store,
    reopen: () => {
      store.close();
      store = new SqliteTaskStore(databasePath);
      return store;
    },
  };
};

test('승인 commit 뒤 보고서 쓰기가 실패해도 재시작에서 승인과 상태를 복구한다', async (context) => {
  const fixture = await createFixture(context);
  const service = new LocalApprovalService(fixture.store, fixture.failingReporter);
  await assert.rejects(service.approve(fixture.request, fixture.approvalContext), /SYNTHETIC_REPORT_FAILURE/);
  const store = fixture.reopen();
  assert.equal(store.reconcileApprovals(now), 0);
  const task = store.find(fixture.task.taskId);
  assert.ok(task);
  assert.equal(task.status, 'APPROVED');
  assert.equal(store.listApprovals(task.taskId).length, 1);
  const reportPath = await fixture.reporter.write(task);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), task);
  await assert.rejects(new LocalApprovalService(store, fixture.reporter).approve(fixture.request, fixture.approvalContext),
    { code: 'APPROVAL_ALREADY_EXISTS' });
});

test('취소 commit 뒤 보고서 실패에도 취소·승인 스냅샷과 재시도 결과를 보존한다', async (context) => {
  const fixture = await createFixture(context);
  const approval = fixture.store.approve(fixture.request, fixture.approvalContext);
  const service = new LocalApprovalService(fixture.store, fixture.failingReporter);
  await assert.rejects(service.cancel(fixture.task.taskId, ownerId, now), /SYNTHETIC_REPORT_FAILURE/);
  const store = fixture.reopen();
  const result = await new LocalApprovalService(store, fixture.reporter).cancel(fixture.task.taskId, ownerId, now);
  assert.equal(result.task.status, 'CANCELLED');
  assert.equal(result.approvals.length, 1);
  assert.deepEqual(result.approvals[0]?.planSnapshot, approval.planSnapshot);
  assert.equal(result.approvals[0]?.revocationReason, 'OWNER_CANCELLED');
  assert.equal(result.approvals[0]?.usedAt, null);
});
