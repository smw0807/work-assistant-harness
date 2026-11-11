import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { MockReplyDelivery } from '../src/adapters/mock-reply-delivery.js';
import { SqliteReplyStore } from '../src/adapters/sqlite-reply-store.js';
import { SyntheticReplyService } from '../src/application/send-reply.js';
import type { ReplyDeliveryResult } from '../src/domain/reply.js';
import type { MockReplyDeliveryPort } from '../src/ports/reply.js';
import { createReplyPlan } from '../src/policy/reply-policy.js';

const ownerId = `os-user:${process.getuid?.()}`;
const now = new Date('2026-11-11T00:00:00.000Z');
const setup = async (context: TestContext, delivery: MockReplyDeliveryPort = new MockReplyDelivery()) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-reply-service-'));
  const path = join(directory, 'replies.sqlite');
  const store = new SqliteReplyStore(path);
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const service = new SyntheticReplyService(store, delivery, () => now);
  return { directory, path, store, service };
};

test('승인만 기록하면 adapter는 호출하지 않고 모의 전송 성공 뒤에는 어떤 승인으로도 다시 보내지 않는다', async (context) => {
  let calls = 0;
  const mock = new MockReplyDelivery();
  const { store, service } = await setup(context, { mode: 'mock', deliver: async (claim) => {
    calls += 1;
    return mock.deliver(claim);
  } });
  const { task } = service.create('success', ownerId, now);
  const request = { taskId: task.taskId, planHash: task.plan.planHash, expiresInMinutes: 30 };
  await assert.rejects(() => service.send(task.taskId, task.plan.planHash, ownerId, now));
  service.approve(request, ownerId, now);
  assert.equal(calls, 0);
  const attempt = await service.send(task.taskId, task.plan.planHash, ownerId, now);
  assert.equal(attempt.status, 'SIMULATED');
  assert.equal(calls, 1);
  await assert.rejects(() => service.send(task.taskId, task.plan.planHash, ownerId, now));
  assert.throws(() => service.approve(request, ownerId, now));
  assert.equal(calls, 1);
  assert.equal(store.inspect(task.taskId, ownerId, now).attemptTotal, 1);
});

test('원시 adapter 오류를 저장하지 않고 결과 불확실로 고정하여 새 승인과 자동 재시도를 차단한다', async (context) => {
  let calls = 0;
  const { store, service } = await setup(context, { mode: 'mock', deliver: async () => {
    calls += 1;
    throw new Error('xoxb-synthetic-private-error-00000000');
  } });
  const { task } = service.create('success', ownerId, now);
  const request = { taskId: task.taskId, planHash: task.plan.planHash, expiresInMinutes: 30 };
  service.approve(request, ownerId, now);
  const attempt = await service.send(task.taskId, task.plan.planHash, ownerId, now);
  assert.equal(attempt.status, 'UNKNOWN');
  assert.equal(attempt.reason, 'REPLY_DELIVERY_UNCERTAIN');
  assert.equal(JSON.stringify(service.inspect(task.taskId, ownerId, now)).includes('synthetic-private-error'), false);
  service.recover(task.taskId, ownerId, now);
  assert.throws(() => service.approve(request, ownerId, now));
  await assert.rejects(() => service.send(task.taskId, task.plan.planHash, ownerId, now));
  assert.equal(calls, 1);
  assert.ok(store.inspect(task.taskId, ownerId, now).approvals[0]?.usedAt);
});

test('전송 중 원문 삭제가 완료와 경합하면 UNKNOWN과 소비 승인을 보존한다', async (context) => {
  let complete: ((result: ReplyDeliveryResult) => void) | undefined;
  const waiting = new Promise<ReplyDeliveryResult>((resolveResult) => { complete = resolveResult; });
  const { store, service } = await setup(context, { mode: 'mock', deliver: async () => waiting });
  const { task } = service.create('success', ownerId, now);
  service.approve({ taskId: task.taskId, planHash: task.plan.planHash, expiresInMinutes: 30 }, ownerId, now);
  const pending = service.send(task.taskId, task.plan.planHash, ownerId, now);
  const claimed = store.inspect(task.taskId, ownerId, now);
  assert.equal(claimed.task.status, 'SENDING');
  const changed = service.control({ taskId: task.taskId, kind: 'deleted', revision: 2, eventId: 'delete-race' }, ownerId, now);
  assert.equal(changed.status, 'UNKNOWN');
  assert.ok(complete);
  complete({ status: 'NOT_SENT', reason: 'MOCK_NOT_SENT', receiptId: null });
  await assert.rejects(pending);
  const snapshot = service.inspect(task.taskId, ownerId, now);
  assert.equal(snapshot.task.status, 'UNKNOWN');
  assert.equal(snapshot.attempts[0]?.status, 'UNKNOWN');
  assert.ok(snapshot.approvals[0]?.usedAt);
});

test('controller SIGKILL 뒤 새 프로세스의 조회는 SENDING을 유지하고 명시 복구만 UNKNOWN으로 확정한다', async (context) => {
  const { path, service } = await setup(context);
  const { plan, body } = createReplyPlan('success', ownerId, now);
  // child는 별도 SQLite 연결에서 승인 소비를 commit한 직후 강제 종료한다.
  const script = `
    import { SqliteReplyStore } from ${JSON.stringify(pathToFileURL(resolve('dist/src/adapters/sqlite-reply-store.js')).href)};
    const store = new SqliteReplyStore(${JSON.stringify(path)});
    const now = new Date(${JSON.stringify(now.toISOString())});
    const plan = ${JSON.stringify(plan)};
    store.create(plan, ${JSON.stringify(body)}, now);
    store.approve({taskId: plan.taskId, planHash: plan.planHash, expiresInMinutes: 30}, ${JSON.stringify(ownerId)}, now);
    store.claim(plan.taskId, plan.planHash, ${JSON.stringify(ownerId)}, now);
    process.kill(process.pid, 'SIGKILL');
  `;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC' },
  }), (error: unknown) => error instanceof Error && 'signal' in error && error.signal === 'SIGKILL');
  assert.equal(service.inspect(plan.taskId, ownerId, now).task.status, 'SENDING');
  const recovered = service.recover(plan.taskId, ownerId, now);
  assert.equal(recovered.task.status, 'UNKNOWN');
  assert.equal(recovered.attempts[0]?.status, 'UNKNOWN');
  assert.ok(recovered.approvals[0]?.usedAt);
  await assert.rejects(() => service.send(plan.taskId, plan.planHash, ownerId, now));
  assert.deepEqual(service.recover(plan.taskId, ownerId, now), recovered);
});
