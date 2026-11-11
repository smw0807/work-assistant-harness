import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteLiveSlackStore } from '../src/adapters/sqlite-live-slack-store.js';
import { LiveSlackService } from '../src/application/live-slack.js';
import type { LiveDeliveryResult, LiveSlackConfig, LiveSource } from '../src/domain/live-slack.js';
import type { LiveSlackPort } from '../src/ports/live-slack.js';
import { assertLiveClaim, assertLivePlan, createLivePlan, hashLiveContext, liveAuditRetentionMs, livePlanLifetimeMs, liveTargetKey, liveTestBody, liveTestRootText } from '../src/policy/live-slack-policy.js';

const owner = `os-user:${process.getuid!()}`;
const time = new Date('2026-11-11T02:00:00.000Z');
const config: LiveSlackConfig = { policy: 'slack-live-test-v1', liveEnabled: true, workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: '1700000000.000001' };
const source = (now = time): LiveSource => ({ botId: 'B_TEST', botUserId: 'U_BOT', rootRevision: config.threadTs,
  contextHash: hashLiveContext({ ts: config.threadTs, user: 'U_OWNER', text: liveTestRootText, revision: config.threadTs }), observedAt: now.toISOString() });
const sent: LiveDeliveryResult = { status: 'SENT', reason: null, receipt: { channelId: config.channelId, threadTs: config.threadTs, messageTs: '1700000001.000001' } };

const setup = (context: { after: (action: () => void) => void }) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-live-store-')));
  chmodSync(directory, 0o700);
  const path = join(directory, 'live-replies.sqlite');
  const store = new SqliteLiveSlackStore(path);
  context.after(() => { try { store.close(); } catch { /* 재시작 테스트에서 이미 닫혔을 수 있다. */ } rmSync(directory, { recursive: true, force: true }); });
  let now = time;
  let captured = source();
  let captureFailure = false;
  let posts = 0;
  let result = sent;
  const port: LiveSlackPort = {
    capture: async () => { if (captureFailure) throw new Error('private-raw-error'); return structuredClone(captured); },
    post: async (claim) => { assertLiveClaim(claim, now); posts += 1; return structuredClone(result); },
  };
  const service = new LiveSlackService(store, port, () => now);
  return { directory, path, store, service, port, posts: () => posts,
    setTime: (value: Date) => { now = value; captured.observedAt = value.toISOString(); },
    setSource: (value: LiveSource) => { captured = value; }, failCapture: () => { captureFailure = true; },
    setResult: (value: LiveDeliveryResult) => { result = value; } };
};

test('live 정책은 모의 승격·추가 키·본문/목적지 변조·다른 소유자·오래된 문맥을 거부한다', () => {
  const plan = createLivePlan(config, source(), owner, time);
  for (const changed of [
    { ...plan, mode: 'mock' }, { ...plan, policy: 'slack-post-contract-v1' }, { ...plan, bodyHash: 'f'.repeat(64) },
    { ...plan, extra: true }, { ...plan, config: { ...config, channelId: 'C_OTHER' } },
  ]) assert.throws(() => assertLivePlan(changed as typeof plan));
  assert.throws(() => createLivePlan({ ...config, liveEnabled: false }, source(), owner, time), /LIVE_DISABLED/);
  assert.throws(() => createLivePlan(config, source(), 'os-user:999999999', time), /LIVE_OWNER_MISMATCH/);
  assert.throws(() => createLivePlan(config, source(new Date(time.getTime() - 5001)), owner, time), /LIVE_CONTEXT_STALE/);
  assert.throws(() => createLivePlan(config, source(new Date(time.getTime() + 1)), owner, time), /LIVE_CONTEXT_STALE/);
});

test('계획/승인만으로 POST하지 않고 DB에는 원문·전송 본문을 저장하지 않는다', async (context) => {
  const fixture = setup(context);
  const snapshot = await fixture.service.create(config, owner);
  assert.equal(snapshot.task.status, 'AWAITING_APPROVAL');
  assert.equal(snapshot.body, liveTestBody);
  const approval = await fixture.service.approve(snapshot.task.plan.taskId, snapshot.task.plan.planHash, 30, owner);
  assert.equal(approval.usedAt, null);
  assert.equal(fixture.posts(), 0);
  const content = readFileSync(fixture.path).toString('utf8');
  assert.equal(content.includes(liveTestBody), false);
  assert.equal(content.includes(liveTestRootText), false);
  assert.equal(content.includes('xoxb-'), false);
});

test('승인 TTL·계획 hash·소유자가 맞아야 하며 승인 없이는 전송하지 않는다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  const { taskId, planHash } = task.plan;
  for (const ttl of [0, 61, 1.5, NaN]) await assert.rejects(fixture.service.approve(taskId, planHash, ttl, owner), /LIVE_INVALID_TTL/);
  await assert.rejects(fixture.service.approve(taskId, 'f'.repeat(64), 1, owner), /LIVE_PLAN_HASH_MISMATCH/);
  await assert.rejects(fixture.service.approve(taskId, planHash, 1, 'os-user:999999999'), /LIVE_OWNER_MISMATCH/);
  await assert.rejects(fixture.service.send(taskId, planHash, owner), /LIVE_APPROVAL_REQUIRED/);
  assert.equal(fixture.posts(), 0);
  assert.equal(fixture.service.inspect(taskId, owner).approvals.length, 0);
});

test('승인 소비·SENDING·대상 잠금을 원자 확정하고 동시 send도 POST 한 번만 수행한다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  await fixture.service.approve(task.plan.taskId, task.plan.planHash, 30, owner);
  const outcomes = await Promise.allSettled([
    fixture.service.send(task.plan.taskId, task.plan.planHash, owner), fixture.service.send(task.plan.taskId, task.plan.planHash, owner),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(fixture.posts(), 1);
  const snapshot = fixture.service.inspect(task.plan.taskId, owner);
  assert.equal(snapshot.task.status, 'SENT');
  assert.equal(snapshot.approvals[0]?.usedAt, time.toISOString());
  assert.equal(snapshot.attempts.length, 1);
  await assert.rejects(fixture.service.create(config, owner), /LIVE_TARGET_ALREADY_ATTEMPTED/);
});

test('claim 트랜잭션 저장 실패는 승인 소비와 SENDING을 함께 rollback한다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
  const raw = new DatabaseSync(fixture.path);
  raw.exec("CREATE TRIGGER reject_live_attempt BEFORE INSERT ON live_attempts BEGIN SELECT RAISE(ABORT, 'synthetic'); END;");
  assert.throws(() => fixture.store.claim(task.plan.taskId, task.plan.planHash, owner, source(), time));
  raw.exec('DROP TRIGGER reject_live_attempt'); raw.close();
  const snapshot = fixture.service.inspect(task.plan.taskId, owner);
  assert.equal(snapshot.task.status, 'APPROVED');
  assert.equal(snapshot.approvals[0]?.usedAt, null);
  assert.equal(snapshot.attempts.length, 0);
});

test('편집 revision·새 문맥·다른 bot identity는 기존 승인을 무효화하고 POST 0회다', async (context) => {
  for (const patch of [{ rootRevision: '1700000000.00000000000009' }, { contextHash: 'f'.repeat(64) }, { botId: 'B_OTHER' }, { botUserId: 'U_OTHER' }]) {
    const fixture = setup(context);
    const { task } = await fixture.service.create(config, owner);
    await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
    fixture.setSource({ ...source(), ...patch });
    await assert.rejects(fixture.service.send(task.plan.taskId, task.plan.planHash, owner), /LIVE_SOURCE_NOT_CONFIRMED/);
    const snapshot = fixture.service.inspect(task.plan.taskId, owner);
    assert.equal(snapshot.task.status, 'BLOCKED');
    assert.equal(snapshot.approvals[0]?.revokedAt, time.toISOString());
    assert.equal(snapshot.attempts.length, 0); assert.equal(fixture.posts(), 0);
  }
});

test('문맥 조회 실패는 원시 오류 없이 승인 차단으로 기록한다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  fixture.failCapture();
  await assert.rejects(fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner), { message: 'LIVE_SOURCE_NOT_CONFIRMED' });
  assert.equal(fixture.service.inspect(task.plan.taskId, owner).task.status, 'BLOCKED');
  assert.equal(readFileSync(fixture.path).includes(Buffer.from('private-raw-error')), false);
});

test('승인 만료는 새 승인을 요구하고 계획 만료 후 고정 본문도 표시하지 않는다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
  fixture.setTime(new Date(time.getTime() + 60_000));
  await assert.rejects(fixture.service.send(task.plan.taskId, task.plan.planHash, owner), /LIVE_APPROVAL_REQUIRED/);
  assert.equal(fixture.service.inspect(task.plan.taskId, owner).approvals[0]?.revokedAt, new Date(time.getTime() + 60_000).toISOString());
  await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
  fixture.setTime(new Date(time.getTime() + livePlanLifetimeMs));
  const snapshot = fixture.service.inspect(task.plan.taskId, owner);
  assert.equal(snapshot.body, null); assert.equal(snapshot.task.status, 'BLOCKED');
  await assert.rejects(fixture.service.send(task.plan.taskId, task.plan.planHash, owner));
  assert.equal(fixture.posts(), 0);
});

test('확실한 미전송 뒤 승인 소비를 복원하지 않고 새 승인으로만 수동 재시도한다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
  fixture.setResult({ status: 'NOT_SENT', reason: 'LIVE_SLACK_RATE_LIMITED', receipt: null });
  assert.equal((await fixture.service.send(task.plan.taskId, task.plan.planHash, owner)).status, 'NOT_SENT');
  await assert.rejects(fixture.service.send(task.plan.taskId, task.plan.planHash, owner), /LIVE_APPROVAL_REQUIRED/);
  await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
  fixture.setResult(sent);
  assert.equal((await fixture.service.send(task.plan.taskId, task.plan.planHash, owner)).status, 'SENT');
  const snapshot = fixture.service.inspect(task.plan.taskId, owner);
  assert.equal(snapshot.attempts.length, 2); assert.equal(snapshot.approvals.filter((approval) => approval.usedAt !== null).length, 2);
  assert.equal(fixture.posts(), 2);
});

test('불확실한 결과·어댑터 예외·잘못된 결과는 UNKNOWN으로 보존하고 새 계획도 차단한다', async (context) => {
  for (const variant of ['unknown', 'throw', 'invalid']) {
    const fixture = setup(context);
    const { task } = await fixture.service.create(config, owner);
    await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
    fixture.setResult({ status: 'UNKNOWN', reason: 'LIVE_SLACK_REQUEST_FAILED', receipt: null });
    if (variant === 'throw') fixture.port.post = async () => { throw new Error('private-adapter-error'); };
    if (variant === 'invalid') fixture.port.post = async () => ({ status: 'SENT', reason: 'private-bad-result', receipt: null });
    assert.equal((await fixture.service.send(task.plan.taskId, task.plan.planHash, owner)).status, 'UNKNOWN');
    await assert.rejects(fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner), /LIVE_TASK_NOT_READY/);
    await assert.rejects(fixture.service.create(config, owner), /LIVE_TARGET_ALREADY_ATTEMPTED/);
    assert.equal(readFileSync(fixture.path).includes(Buffer.from('private-')), false);
  }
});

test('취소가 승인을 폐기하며 새 계획으로 대체된 옛 계획은 소비할 수 없다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
  assert.equal(fixture.service.cancel(task.plan.taskId, owner).task.status, 'CANCELLED');
  assert.notEqual(fixture.service.inspect(task.plan.taskId, owner).approvals[0]?.revokedAt, null);
  const next = await fixture.service.create(config, owner);
  assert.notEqual(next.task.plan.taskId, task.plan.taskId);
  await assert.rejects(fixture.service.send(task.plan.taskId, task.plan.planHash, owner));
  assert.equal(fixture.posts(), 0);
});

test('강제 종료 뒤 새 프로세스의 복구는 SENDING을 UNKNOWN으로 만들고 재전송하지 않는다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
  fixture.store.close();
  const script = `import { SqliteLiveSlackStore } from ${JSON.stringify(resolve('dist/src/adapters/sqlite-live-slack-store.js'))};
    const store=new SqliteLiveSlackStore(process.argv[1]);
    store.claim(${JSON.stringify(task.plan.taskId)},${JSON.stringify(task.plan.planHash)},${JSON.stringify(owner)},${JSON.stringify(source())},new Date(${JSON.stringify(time.toISOString())}));
    process.stdout.write('CLAIMED');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, fixture.path], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const signal = AbortSignal.timeout(10_000);
  await once(child.stdout, 'data', { signal });
  child.kill('SIGKILL'); await exit;
  const reopened = new SqliteLiveSlackStore(fixture.path);
  try {
    assert.equal(reopened.inspect(task.plan.taskId, owner, time).task.status, 'SENDING');
    assert.equal(reopened.recover(task.plan.taskId, owner, time).task.status, 'UNKNOWN');
    assert.equal(reopened.recover(task.plan.taskId, owner, time).attempts.length, 1);
    assert.throws(() => reopened.create(createLivePlan(config, source(), owner, time), time), /LIVE_TARGET_ALREADY_ATTEMPTED/);
  } finally { reopened.close(); }
});

test('감사 정리 뒤에도 성공·불확실 대상 marker는 남아 새 계획을 막는다', async (context) => {
  for (const status of ['SENT', 'UNKNOWN'] as const) {
    const fixture = setup(context);
    const { task } = await fixture.service.create(config, owner);
    await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
    fixture.setResult(status === 'SENT' ? sent : { status, reason: 'LIVE_SLACK_REQUEST_FAILED', receipt: null });
    await fixture.service.send(task.plan.taskId, task.plan.planHash, owner);
    fixture.setTime(new Date(time.getTime() + liveAuditRetentionMs));
    assert.equal(fixture.service.maintain().purgedAudits, 1);
    assert.equal(fixture.service.list(owner).length, 0);
    await assert.rejects(fixture.service.create(config, owner), /LIVE_TARGET_ALREADY_ATTEMPTED/);
  }
});

test('DB·저널 symlink/hardlink와 비공개 권한 위반을 거부한다', (context) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-live-path-')));
  chmodSync(directory, 0o700); context.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'other'); writeFileSync(target, '', { mode: 0o600 });
  const path = join(directory, 'live-replies.sqlite');
  symlinkSync(target, path); assert.throws(() => new SqliteLiveSlackStore(path)); rmSync(path);
  linkSync(target, path); assert.throws(() => new SqliteLiveSlackStore(path)); rmSync(path);
  symlinkSync(target, `${path}-journal`); assert.throws(() => new SqliteLiveSlackStore(path)); rmSync(`${path}-journal`);
  writeFileSync(path, '', { mode: 0o644 }); assert.throws(() => new SqliteLiveSlackStore(path));
});

test('승인 snapshot 변조는 승인 소비 이전에 거부한다', async (context) => {
  const fixture = setup(context);
  const { task } = await fixture.service.create(config, owner);
  const approval = await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
  const altered = structuredClone(approval); altered.planSnapshot.config.channelId = 'C_OTHER';
  const raw = new DatabaseSync(fixture.path);
  raw.prepare('UPDATE live_approvals SET payload=? WHERE approval_id=?').run(JSON.stringify(altered), approval.approvalId); raw.close();
  assert.throws(() => fixture.store.claim(task.plan.taskId, task.plan.planHash, owner, source(), time));
  assert.equal(fixture.posts(), 0);
});

test('변조된 DB receipt·승인 row는 원문을 출력하지 않고 조회부터 거부한다', async (context) => {
  for (const variant of ['receipt', 'approval-row']) {
    const fixture = setup(context);
    const { task } = await fixture.service.create(config, owner);
    const approval = await fixture.service.approve(task.plan.taskId, task.plan.planHash, 1, owner);
    const claim = fixture.store.claim(task.plan.taskId, task.plan.planHash, owner, source(), time);
    const raw = new DatabaseSync(fixture.path);
    if (variant === 'receipt') {
      raw.prepare('UPDATE live_attempts SET payload=? WHERE attempt_id=?')
        .run(JSON.stringify({ ...claim.attempt, receipt: { body: 'SYNTHETIC_PRIVATE_BODY' } }), claim.attempt.attemptId);
    } else raw.prepare('UPDATE live_approvals SET used_at=NULL WHERE approval_id=?').run(approval.approvalId);
    raw.close();
    assert.throws(() => fixture.service.inspect(task.plan.taskId, owner), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('SYNTHETIC_PRIVATE_BODY'), false);
      return /^LIVE_INVALID_STORED_(?:ATTEMPT|APPROVAL)$/.test(error.message);
    });
  }
});

test('같은 timestamp의 표현 차이로 대상 중복 marker를 우회할 수 없다', () => {
  assert.equal(liveTargetKey(config), liveTargetKey({ ...config, threadTs: '01700000000.0000010' }));
  assert.notEqual(liveTargetKey(config), liveTargetKey({ ...config, threadTs: '1700000000.0000010000000001' }));
});

test('잘못된 소유자·비활성 설정은 서비스에서도 실제 조회 이전에 거부한다', async (context) => {
  const fixture = setup(context);
  let captures = 0;
  fixture.port.capture = async () => { captures += 1; return source(); };
  await assert.rejects(fixture.service.create(config, 'os-user:999999999'), /LIVE_OWNER_MISMATCH/);
  await assert.rejects(fixture.service.create({ ...config, liveEnabled: false }, owner), /LIVE_DISABLED/);
  assert.equal(captures, 0);
});
