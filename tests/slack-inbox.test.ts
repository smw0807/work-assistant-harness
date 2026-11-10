import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import { SqliteTaskStore } from '../src/adapters/sqlite-task-store.js';
import type { SlackMessageChange, SlackReceiverConfig, SlackThreadSnapshot } from '../src/domain/slack.js';
import type { Task } from '../src/domain/types.js';

const config: SlackReceiverConfig = {
  workspaceId: 'W_LOCAL', channelIds: ['C_ALLOWED'], targetUserId: 'U_OWNER',
  retentionHours: 24, maxPending: 10,
  thread: { maxMessages: 10, maxPages: 2, maxBytes: 16_384 }, liveReadEnabled: false,
};
const now = new Date('2026-11-10T00:00:00.000Z');
const event = (overrides: Partial<SlackMessageChange> = {}): SlackMessageChange => ({
  kind: 'created', eventId: 'Ev_first', workspaceId: 'W_LOCAL', channelId: 'C_ALLOWED',
  messageTs: '1700000000.000001', threadTs: '1700000000.000001', requesterId: 'U_REQUESTER',
  revision: '1700000000.000001', text: '<@U_OWNER> 합성 요청입니다.', mentionsTarget: true, ...overrides,
});
const thread: SlackThreadSnapshot = {
  messages: [{ ts: '1700000000.000001', user: 'U_REQUESTER', text: '합성 스레드 문맥' }], complete: true, reason: null,
};

const temporaryDirectory = async (context: TestContext): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-slack-inbox-')));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const openInbox = async (context: TestContext, overrides: Partial<SlackReceiverConfig> = {}) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, 'tasks.sqlite');
  const inbox = new SqliteSlackInbox(path, { ...config, ...overrides });
  context.after(() => inbox.close());
  return { directory, path, inbox };
};

const plannedTask = (taskId: string, overrides: Partial<Task> = {}): Task => ({
  taskId, workspaceId: 'W_LOCAL', channelId: 'C_ALLOWED', eventId: `Ev_${taskId}`,
  threadTs: '1700000000.000001', messageTs: '1700000000.000001', requesterId: 'U_REQUESTER',
  requestRevision: '1700000000.000001', classification: 'change', status: 'AWAITING_APPROVAL',
  repoId: 'sample', baseCommit: 'a'.repeat(40), createdAt: now.toISOString(), updatedAt: now.toISOString(),
  history: ['RECEIVED', 'TRIAGED', 'ANALYZED', 'AWAITING_APPROVAL'], failureCode: null,
  plan: {
    planId: 'plan_synthetic', version: 1, requestRevision: '1700000000.000001', repoId: 'sample',
    baseCommit: 'a'.repeat(40), objective: '합성 계획', allowedFiles: ['src/example.ts'],
    proposedChanges: ['합성 변경'], testCommandIds: [], risks: [], planHash: 'a'.repeat(64),
  },
  report: {
    summary: '합성 보고', facts: [], hypotheses: [], evidence: [], answerDraft: '', questions: [],
    risks: [], checks: [], nextApproval: '소유자 검토 필요',
  },
  ...overrides,
});

test('수신은 영속 저장하고 중복·claim·재시작 후 기록을 보존한다', async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, 'tasks.sqlite');
  const inbox = new SqliteSlackInbox(path, config);
  assert.equal(inbox.receive(event(), now), 'accepted');
  assert.equal(inbox.receive(event(), now), 'duplicate');
  assert.equal(inbox.pending().length, 1);
  assert.equal(inbox.find('W_LOCAL', 'C_ALLOWED', event().messageTs)?.status, 'RECEIVED');
  assert.equal(inbox.claim(event().eventId, 'W_OTHER'), false);
  assert.equal(inbox.claim(event().eventId, 'W_LOCAL'), true);
  assert.equal(inbox.claim(event().eventId, 'W_LOCAL'), false);
  inbox.complete(event(), thread, now);
  inbox.close();
  const reopened = new SqliteSlackInbox(path, config);
  context.after(() => reopened.close());
  assert.equal(reopened.pending().length, 0);
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list()[0]?.status, 'RECORDED');
  assert.deepEqual(reopened.list()[0]?.thread, thread);
  assert.equal(reopened.receive(event(), now), 'duplicate');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('허용 범위·사용자 ID·멘션·입력 크기를 수신 어댑터에서도 검사한다', async (context) => {
  const { inbox } = await openInbox(context);
  for (const overrides of [
    { workspaceId: 'W_DENIED' }, { channelId: 'C_DENIED' }, { requesterId: 'U_OWNER' },
    { text: '멘션 없음', mentionsTarget: false },
    { eventId: '../escape' }, { revision: 'invalid' }, { text: `<@U_OWNER> ${'가'.repeat(6_000)}` },
  ]) assert.equal(inbox.receive(event(overrides), now), 'ignored');
  assert.equal(inbox.pending().length, 0);
  assert.equal(inbox.list().length, 0);
});

test('큐 포화 시 새 이벤트를 저장하지 않으며 중복·동일 메시지 개정은 처리한다', async (context) => {
  const { inbox } = await openInbox(context, { maxPending: 1 });
  inbox.receive(event(), now);
  assert.equal(inbox.receive(event(), now), 'duplicate');
  const another = event({ eventId: 'Ev_another', messageTs: '1700000001.000001' });
  assert.throws(() => inbox.receive(another, now), { code: 'SLACK_INBOX_FULL' });
  assert.equal(inbox.list().length, 1);
  const edited = event({ kind: 'edited', eventId: 'Ev_edited', revision: '1700000002.000001' });
  assert.equal(inbox.receive(edited, now), 'accepted');
  assert.equal(inbox.pending().length, 1);
  assert.equal(inbox.pending()[0]?.event.eventId, edited.eventId);
  inbox.claim(edited.eventId, edited.workspaceId);
  inbox.complete(edited, null, now);
  assert.equal(inbox.receive(another, now), 'accepted');
});

test('다른 요청으로 큐가 가득 차도 삭제·멘션 제거는 본문과 계획을 즉시 무효화한다', async (context) => {
  for (const kind of ['deleted', 'edited'] as const) {
    const { inbox, path } = await openInbox(context, { maxPending: 1 });
    const tasks = new SqliteTaskStore(path);
    context.after(() => tasks.close());
    tasks.create(plannedTask(`saturated_${kind}`));
    inbox.receive(event(), now);
    inbox.claim(event().eventId, event().workspaceId);
    inbox.complete(event(), thread, now);
    const queued = event({ eventId: 'Ev_other_pending', messageTs: '1700000001.000001', threadTs: '1700000001.000001' });
    inbox.receive(queued, now);
    const mutation = event({ kind, eventId: 'Ev_invalidate', revision: '1700000002.000001', text: '', mentionsTarget: false });
    assert.equal(inbox.receive(mutation, now), 'accepted');
    const request = inbox.find(event().workspaceId, event().channelId, event().messageTs);
    assert.equal(request?.status, 'INVALIDATED');
    assert.equal(request?.text, '');
    assert.equal(request?.thread, null);
    assert.equal(tasks.find(`saturated_${kind}`)?.status, 'CANCELLED');
    assert.equal(tasks.find(`saturated_${kind}`)?.plan, null);
    assert.deepEqual(inbox.pending().map((item) => item.event.eventId), [queued.eventId]);
    assert.equal(inbox.claim(mutation.eventId, mutation.workspaceId), false);
  }
});

test('멘션을 유지한 편집도 큐 포화 시 계획을 취소하고 최신 요청을 BLOCKED로 저장한다', async (context) => {
  const { inbox, path } = await openInbox(context, { maxPending: 1 });
  const tasks = new SqliteTaskStore(path);
  context.after(() => tasks.close());
  tasks.create(plannedTask('full_edited'));
  inbox.receive(event(), now);
  inbox.claim(event().eventId, event().workspaceId);
  inbox.complete(event(), thread, now);
  const queued = event({ eventId: 'Ev_other_pending', messageTs: '1700000001.000001', threadTs: '1700000001.000001' });
  inbox.receive(queued, now);
  const edited = event({ kind: 'edited', eventId: 'Ev_full_edit', revision: '1700000002.000001', text: '<@U_OWNER> 최신 수정 본문' });
  assert.equal(inbox.receive(edited, now), 'accepted');
  assert.equal(inbox.receive(edited, now), 'duplicate');
  const request = inbox.find(edited.workspaceId, edited.channelId, edited.messageTs);
  assert.equal(request?.status, 'BLOCKED');
  assert.equal(request?.failureCode, 'SLACK_INBOX_FULL');
  assert.equal(request?.text, edited.text);
  assert.equal(request?.thread, null);
  assert.equal(tasks.find('full_edited')?.status, 'CANCELLED');
  assert.equal(tasks.find('full_edited')?.plan, null);
  assert.deepEqual(inbox.pending().map((item) => item.event.eventId), [queued.eventId]);
  assert.equal(inbox.claim(edited.eventId, edited.workspaceId), false);
  const newMention = event({ kind: 'edited', eventId: 'Ev_new_mention_full',
    messageTs: '1700000003.000001', threadTs: '1700000003.000001', revision: '1700000004.000001' });
  assert.equal(inbox.receive(newMention, now), 'accepted');
  assert.equal(inbox.find(newMention.workspaceId, newMention.channelId, newMention.messageTs)?.failureCode, 'SLACK_INBOX_FULL');
});

test('편집의 멘션 추가를 수집하고 늦게 온 원본과 이전 revision을 무시한다', async (context) => {
  const { inbox } = await openInbox(context);
  const edited = event({ kind: 'edited', eventId: 'Ev_edit_first', revision: '1700000002.000001', text: '<@U_OWNER> 편집된 합성 요청' });
  assert.equal(inbox.receive(edited, now), 'accepted');
  assert.equal(inbox.receive(event(), now), 'ignored');
  assert.equal(inbox.list()[0]?.text, edited.text);
  assert.equal(inbox.pending().length, 1);
  assert.equal(inbox.receive(event({ kind: 'edited', eventId: 'Ev_stale', revision: '1700000001.000001' }), now), 'ignored');
  assert.equal(inbox.list()[0]?.revision, edited.revision);
});

test('추적하지 않은 편집은 marker만 남기고 새 멘션 편집으로 추적을 시작한다', async (context) => {
  const { inbox } = await openInbox(context);
  const unmentioned = event({ kind: 'edited', eventId: 'Ev_no_mention', revision: '1700000002.000001', text: '무멘션 본문', mentionsTarget: false });
  assert.equal(inbox.receive(unmentioned, now), 'ignored');
  assert.equal(inbox.list().length, 0);
  assert.equal(inbox.receive(event(), now), 'ignored');
  assert.equal(inbox.receive(event({ kind: 'edited', eventId: 'Ev_add_mention', revision: '1700000003.000001' }), now), 'accepted');
  assert.equal(inbox.list().length, 1);
});

test('revision은 Number 정밀도와 문자열 정렬에 의존하지 않고 비교한다', async (context) => {
  const { inbox } = await openInbox(context);
  const original = event({ messageTs: '9999999999999999999.9999999998', threadTs: '9999999999999999999.9999999998', revision: '9999999999999999999.9999999998' });
  inbox.receive(original, now);
  const firstEdit = { ...original, kind: 'edited' as const, eventId: 'Ev_first_edit', revision: '9999999999999999999.9999999999' };
  assert.equal(inbox.receive(firstEdit, now), 'accepted');
  assert.equal(inbox.list()[0]?.revision, firstEdit.revision);
  const secondEdit = { ...firstEdit, eventId: 'Ev_second_edit', revision: '10000000000000000000.0000000000' };
  assert.equal(inbox.receive(secondEdit, now), 'accepted');
  assert.equal(inbox.list()[0]?.revision, secondEdit.revision);
  assert.equal(inbox.receive({ ...firstEdit, eventId: 'Ev_stale_precision' }, now), 'ignored');
});

test('삭제가 원본보다 먼저 와도 tombstone이 이후 create·edit 부활을 막는다', async (context) => {
  const { inbox } = await openInbox(context);
  const deleted = event({ kind: 'deleted', eventId: 'Ev_delete_first', revision: '1700000002.000001', requesterId: '', text: '', mentionsTarget: false });
  assert.equal(inbox.receive(deleted, now), 'ignored');
  assert.equal(inbox.receive(event(), now), 'ignored');
  assert.equal(inbox.receive(event({ kind: 'edited', eventId: 'Ev_after_delete', revision: '1700000003.000001' }), now), 'ignored');
  assert.equal(inbox.pending().length, 0);
  assert.equal(inbox.list().length, 0);
});

test('메시지 개정은 기존 본문·스레드를 즉시 지우고 늦은 complete를 거부한다', async (context) => {
  const { inbox, path } = await openInbox(context);
  const original = event({ text: '<@U_OWNER> OLD_SYNTHETIC_MESSAGE' });
  inbox.receive(original, now);
  inbox.claim(original.eventId, original.workspaceId);
  inbox.complete(original, thread, now);
  const edited = event({ kind: 'edited', eventId: 'Ev_edited', revision: '1700000002.000001', text: '<@U_OWNER> 새 합성 본문' });
  inbox.receive(edited, now);
  assert.equal(inbox.list()[0]?.status, 'RECEIVED');
  assert.equal(inbox.list()[0]?.thread, null);
  inbox.complete(original, thread, now);
  assert.equal(inbox.list()[0]?.eventId, edited.eventId);
  const removed = event({ kind: 'edited', eventId: 'Ev_removed', revision: '1700000003.000001', text: 'UNTRACKED_SYNTHETIC_MESSAGE', mentionsTarget: false });
  inbox.receive(removed, now);
  assert.equal(inbox.list()[0]?.status, 'INVALIDATED');
  assert.equal(inbox.list()[0]?.text, '');
  assert.equal(inbox.list()[0]?.thread, null);
  inbox.complete(edited, thread, now);
  inbox.claim(removed.eventId, removed.workspaceId);
  inbox.complete(removed, thread, now);
  assert.equal(inbox.list()[0]?.status, 'INVALIDATED');
  const databaseContents = await readFile(path);
  assert.equal(databaseContents.includes(Buffer.from('OLD_SYNTHETIC_MESSAGE')), false);
  assert.equal(databaseContents.includes(Buffer.from('UNTRACKED_SYNTHETIC_MESSAGE')), false);
});

test('다른 reply의 변경·삭제는 cached·pending·processing 스레드 문맥과 관련 계획을 무효화한다', async (context) => {
  const { inbox, path } = await openInbox(context);
  const tasks = new SqliteTaskStore(path);
  context.after(() => tasks.close());
  tasks.create(plannedTask('cached_thread'));
  inbox.receive(event(), now);
  inbox.claim(event().eventId, event().workspaceId);
  const replyTs = '1700000003.000001';
  inbox.complete(event(), { ...thread, messages: [
    ...thread.messages, { ts: replyTs, user: 'U_OTHER', text: 'CACHED_SYNTHETIC_REPLY' },
  ] }, now);
  const inferredSibling = event({ eventId: 'Ev_inferred_sibling', messageTs: '1700000002.000001' });
  inbox.receive(inferredSibling, now);
  const unknownDelete = event({
    kind: 'deleted', eventId: 'Ev_unknown_reply_deleted', messageTs: replyTs, threadTs: replyTs,
    revision: '1700000004.000001', requesterId: '', text: '', mentionsTarget: false,
  });
  assert.equal(inbox.receive(unknownDelete, now), 'ignored');
  assert.equal(inbox.list()[0]?.status, 'INVALIDATED');
  assert.equal(inbox.list()[0]?.failureCode, 'THREAD_CHANGED');
  assert.equal(inbox.list()[0]?.thread, null);
  assert.equal(inbox.list()[0]?.text, event().text, '별도 요청 본문은 유지하고 변경된 스레드만 제거합니다.');
  assert.equal(tasks.find('cached_thread')?.status, 'CANCELLED');
  assert.equal(tasks.find('cached_thread')?.plan, null);
  assert.equal(inbox.pending().length, 0);
  assert.equal(inbox.claim(inferredSibling.eventId, inferredSibling.workspaceId), false);
  assert.equal(inbox.find(inferredSibling.workspaceId, inferredSibling.channelId, inferredSibling.messageTs)?.failureCode, 'THREAD_CHANGED');
  assert.equal((await readFile(path)).includes(Buffer.from('CACHED_SYNTHETIC_REPLY')), false);

  const processing = event({ kind: 'edited', eventId: 'Ev_root_refresh', revision: '1700000005.000001' });
  inbox.receive(processing, now);
  inbox.claim(processing.eventId, processing.workspaceId);
  const pending = event({ eventId: 'Ev_sibling_pending', messageTs: '1700000006.000001' });
  inbox.receive(pending, now);
  assert.equal(inbox.pending().length, 1);
  const replyEdit = event({ kind: 'edited', eventId: 'Ev_unmentioned_reply_edit', messageTs: '1700000007.000001',
    revision: '1700000008.000001', text: '', mentionsTarget: false });
  assert.equal(inbox.receive(replyEdit, now), 'ignored');
  assert.equal(inbox.pending().length, 0);
  assert.equal(inbox.claim(pending.eventId, pending.workspaceId), false);
  inbox.complete(processing, thread, now);
  for (const request of inbox.list()) {
    assert.equal(request.status, 'INVALIDATED');
    assert.equal(request.failureCode, 'THREAD_CHANGED');
    assert.equal(request.thread, null);
  }
});

test('root를 추론할 수 없는 삭제는 같은 채널의 진행 중 수집을 막고 완료된 별도 스레드는 보존한다', async (context) => {
  const { inbox, path } = await openInbox(context);
  const tasks = new SqliteTaskStore(path);
  context.after(() => tasks.close());
  const completed = event({ eventId: 'Ev_completed_other', messageTs: '1700000010.000001', threadTs: '1700000010.000001' });
  inbox.receive(completed, now);
  inbox.claim(completed.eventId, completed.workspaceId);
  inbox.complete(completed, thread, now);
  tasks.create(plannedTask('completed_other', { messageTs: completed.messageTs, threadTs: completed.threadTs }));
  inbox.receive(event(), now);
  inbox.claim(event().eventId, event().workspaceId);
  tasks.create(plannedTask('inflight_root'));
  const pending = event({ eventId: 'Ev_pending_other', messageTs: '1700000002.000001', threadTs: '1700000002.000001' });
  inbox.receive(pending, now);
  tasks.create(plannedTask('pending_root', { messageTs: pending.messageTs, threadTs: pending.threadTs }));
  const deleted = event({ kind: 'deleted', eventId: 'Ev_unknown_root_deleted',
    messageTs: '1700000003.000001', threadTs: '1700000003.000001', revision: '1700000004.000001',
    requesterId: '', text: '', mentionsTarget: false });
  assert.equal(inbox.receive(deleted, now), 'ignored');
  inbox.complete(event(), { ...thread, messages: [
    { ts: deleted.messageTs, user: 'U_OTHER', text: 'DELETED_REPLY_MUST_NOT_RETURN' },
  ] }, now);
  for (const input of [event(), pending]) {
    const request = inbox.find(input.workspaceId, input.channelId, input.messageTs);
    assert.equal(request?.status, 'INVALIDATED');
    assert.equal(request?.failureCode, 'THREAD_CHANGED');
    assert.equal(request?.thread, null);
    assert.equal(inbox.claim(input.eventId, input.workspaceId), false);
  }
  assert.equal(inbox.pending().length, 0);
  for (const id of ['inflight_root', 'pending_root']) {
    assert.equal(tasks.find(id)?.status, 'CANCELLED');
    assert.equal(tasks.find(id)?.plan, null);
  }
  assert.equal(tasks.find('completed_other')?.status, 'AWAITING_APPROVAL');
  assert.equal(inbox.find(completed.workspaceId, completed.channelId, completed.messageTs)?.status, 'RECORDED');
  assert.deepEqual(inbox.find(completed.workspaceId, completed.channelId, completed.messageTs)?.thread, thread);
  assert.equal((await readFile(path)).includes(Buffer.from('DELETED_REPLY_MUST_NOT_RETURN')), false);
  const connection = new DatabaseSync(path);
  context.after(() => connection.close());
  const marker = connection.prepare('SELECT failure_code FROM slack_inbox WHERE event_id = ?').get(event().eventId);
  assert.equal(marker?.failure_code, 'THREAD_CHANGED_UNKNOWN_ROOT');
});

test('중단된 processing만 BLOCKED로 복구하고 pending은 후속 처리할 수 있다', async (context) => {
  const { inbox } = await openInbox(context);
  const pending = event({ eventId: 'Ev_pending', messageTs: '1700000001.000001' });
  inbox.receive(event(), now);
  inbox.receive(pending, now);
  inbox.claim(event().eventId, event().workspaceId);
  assert.equal(inbox.recoverInterrupted(now), 1);
  assert.equal(inbox.recoverInterrupted(now), 0);
  assert.equal(inbox.find('W_LOCAL', 'C_ALLOWED', event().messageTs)?.status, 'BLOCKED');
  assert.equal(inbox.find('W_LOCAL', 'C_ALLOWED', event().messageTs)?.failureCode, 'INTERRUPTED_REVIEW_REQUIRED');
  assert.equal(inbox.claim(event().eventId, event().workspaceId), false);
  assert.deepEqual(inbox.pending().map((item) => item.event.eventId), [pending.eventId]);
  inbox.complete(event(), thread, now);
  assert.equal(inbox.find('W_LOCAL', 'C_ALLOWED', event().messageTs)?.status, 'BLOCKED');
});

test('block은 claim된 최신 요청만 바꾸고 삭제 무효화 상태를 보존한다', async (context) => {
  const { inbox } = await openInbox(context);
  inbox.receive(event(), now);
  inbox.block(event(), 'THREAD_READ_FAILED', now);
  assert.equal(inbox.list()[0]?.status, 'RECEIVED');
  inbox.claim(event().eventId, event().workspaceId);
  inbox.block(event(), 'THREAD_READ_FAILED', now);
  assert.equal(inbox.list()[0]?.status, 'BLOCKED');
  assert.equal(inbox.list()[0]?.failureCode, 'THREAD_READ_FAILED');
  const deleted = event({ kind: 'deleted', eventId: 'Ev_deleted', revision: '1700000002.000001', text: '', mentionsTarget: false });
  inbox.receive(deleted, now);
  inbox.claim(deleted.eventId, deleted.workspaceId);
  inbox.block(deleted, 'THREAD_READ_FAILED', now);
  assert.equal(inbox.list()[0]?.status, 'INVALIDATED');
  assert.equal(inbox.list()[0]?.failureCode, 'REQUEST_DELETED');
});

test('본문·스레드·연결 reason을 방어 마스킹하며 문맥 상한을 지킨다', async (context) => {
  const { inbox, path } = await openInbox(context, { thread: { maxMessages: 1, maxPages: 1, maxBytes: 1_024 } });
  const syntheticToken = `xoxb-${'1234567890'.repeat(3)}`;
  const syntheticAppToken = `xapp-${'1234567890'.repeat(3)}`;
  const syntheticEmail = 'synthetic@example.invalid';
  const syntheticPhone = '010-1234-5678';
  const sensitiveText = `${syntheticToken} ${syntheticAppToken} ${syntheticEmail} ${syntheticPhone}`;
  const input = event({ text: `<@U_OWNER> ${sensitiveText}` });
  inbox.receive(input, now);
  inbox.claim(input.eventId, input.workspaceId);
  inbox.complete(input, { messages: [
    { ts: input.messageTs, user: input.requesterId, text: sensitiveText },
    { ts: '1700000001.000001', user: input.requesterId, text: '상한 초과 합성 문맥' },
  ], complete: true, reason: null }, now);
  inbox.setConnection({ state: 'gap', at: now.toISOString(), reason: `Bearer ${'a'.repeat(20)}` });
  assert.equal(inbox.list()[0]?.text, '<@U_OWNER> [REDACTED] [REDACTED] [REDACTED_EMAIL] [REDACTED_PHONE]');
  assert.equal(inbox.list()[0]?.thread?.messages[0]?.text, '[REDACTED] [REDACTED] [REDACTED_EMAIL] [REDACTED_PHONE]');
  assert.equal(inbox.list()[0]?.thread?.messages.length, 1);
  assert.equal(inbox.list()[0]?.thread?.complete, false);
  assert.equal(inbox.list()[0]?.thread?.reason, 'THREAD_LIMIT_REACHED');
  assert.equal(inbox.connection()?.reason, '[REDACTED]');
  const databaseContents = await readFile(path);
  for (const value of [syntheticToken, syntheticAppToken, syntheticEmail, syntheticPhone]) {
    assert.equal(databaseContents.includes(Buffer.from(value)), false);
  }
  inbox.setConnection({ state: 'connected', at: now.toISOString(), reason: 'SOCKET_READY' });
  assert.equal(inbox.connection()?.state, 'connected');
});

test('연결 공백 이력은 재연결·재시작 후에도 최근 100개를 순서대로 보존한다', async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, 'tasks.sqlite');
  const inbox = new SqliteSlackInbox(path, config);
  inbox.setConnection({ state: 'gap', at: now.toISOString(), reason: 'SOCKET_DISCONNECTED' });
  inbox.setConnection({ state: 'connected', at: now.toISOString(), reason: 'SOCKET_READY' });
  assert.deepEqual(inbox.connectionHistory().map((state) => state.state), ['gap', 'connected']);
  inbox.close();
  const reopened = new SqliteSlackInbox(path, config);
  context.after(() => reopened.close());
  assert.deepEqual(reopened.connectionHistory().map((state) => state.state), ['gap', 'connected']);
  for (let index = 0; index < 101; index += 1) {
    reopened.setConnection({ state: 'gap', at: now.toISOString(), reason: `SYNTHETIC_GAP_${index}` });
  }
  assert.equal(reopened.connectionHistory().length, 100);
  assert.equal(reopened.connectionHistory()[0]?.reason, 'SYNTHETIC_GAP_1');
  assert.equal(reopened.connectionHistory().at(-1)?.reason, 'SYNTHETIC_GAP_100');
  assert.equal(reopened.connection()?.reason, 'SYNTHETIC_GAP_100');
});

test('보관 기간 이후 payload를 지우고 최소 중복·revision·삭제 marker만 보존한다', async (context) => {
  const { inbox, path } = await openInbox(context, { retentionHours: 1 });
  const input = event({ text: '<@U_OWNER> EXPIRING_SYNTHETIC_TEXT' });
  inbox.receive(input, now);
  const deleted = event({ kind: 'deleted', eventId: 'Ev_deleted', messageTs: '1700000002.000001', revision: '1700000003.000001', text: '', mentionsTarget: false });
  inbox.receive(deleted, now);
  assert.equal(inbox.prune(new Date(now.getTime() + 3_599_999)), 0);
  assert.equal(inbox.prune(new Date(now.getTime() + 3_600_000)), 2);
  assert.equal(inbox.prune(new Date(now.getTime() + 3_600_001)), 0);
  assert.equal(inbox.list().length, 0);
  assert.equal(inbox.pending().length, 0);
  assert.equal(inbox.receive(input, now), 'duplicate');
  assert.equal(inbox.receive(event({ eventId: 'Ev_old_again' }), now), 'ignored');
  assert.equal(inbox.receive(event({ eventId: 'Ev_resurrect', messageTs: deleted.messageTs, revision: '1700000004.000001' }), now), 'ignored');
  assert.equal((await readFile(path)).includes(Buffer.from('EXPIRING_SYNTHETIC_TEXT')), false);
});

test('보관 기간 경계에서 늦은 complete·block은 payload를 제거하고 요청을 복원하지 않는다', async (context) => {
  for (const finish of ['complete', 'block'] as const) {
    const { inbox, path } = await openInbox(context, { retentionHours: 1 });
    const input = event({ text: '<@U_OWNER> EXPIRED_SYNTHETIC_REQUEST' });
    inbox.receive(input, now);
    assert.equal(inbox.claim(input.eventId, input.workspaceId), true);
    const expiry = new Date(now.getTime() + 3_600_000);
    if (finish === 'complete') inbox.complete(input, thread, expiry);
    else inbox.block(input, 'THREAD_READ_FAILED', expiry);
    assert.equal(inbox.find(input.workspaceId, input.channelId, input.messageTs), null);
    assert.equal(inbox.pending().length, 0);
    assert.equal(inbox.receive(input, expiry), 'duplicate');
    assert.equal(inbox.claim(input.eventId, input.workspaceId), false);
    assert.equal((await readFile(path)).includes(Buffer.from('EXPIRED_SYNTHETIC_REQUEST')), false);
  }
});

test('편집·삭제 수신 transaction이 동일 메시지 작업의 계획과 보고서를 취소한다', async (context) => {
  const { inbox, path } = await openInbox(context);
  const tasks = new SqliteTaskStore(path);
  context.after(() => tasks.close());
  const legacy = plannedTask('legacy');
  delete legacy.messageTs;
  const ambiguousReply = plannedTask('ambiguous', { requestRevision: '1700000001.000001' });
  delete ambiguousReply.messageTs;
  for (const task of [plannedTask('explicit'), legacy, ambiguousReply,
    plannedTask('other_message', { messageTs: '1700000001.000001' }),
    plannedTask('other_channel', { channelId: 'C_OTHER' }),
    plannedTask('newer_revision', { requestRevision: '1700000004.000001' }),
  ]) assert.equal(tasks.create(task), true);
  const edited = event({ kind: 'edited', eventId: 'Ev_edit', revision: '1700000002.000001' });
  assert.equal(inbox.receive(edited, now), 'accepted');
  for (const id of ['explicit', 'legacy', 'ambiguous', 'other_message']) {
    const task = tasks.find(id);
    assert.equal(task?.status, 'CANCELLED');
    assert.equal(task?.plan, null);
    assert.equal(task?.report, null);
    assert.equal(task?.failureCode, 'REQUEST_CHANGED');
    assert.equal(task?.history.at(-1), 'CANCELLED');
  }
  for (const id of ['other_channel', 'newer_revision']) {
    assert.equal(tasks.find(id)?.status, 'AWAITING_APPROVAL');
  }
  const replyTask = plannedTask('reply', { messageTs: '1700000005.000001', requestRevision: '1700000005.000001' });
  tasks.create(replyTask);
  assert.equal(inbox.receive(event({
    kind: 'deleted', eventId: 'Ev_reply_deleted', messageTs: '1700000005.000001',
    revision: '1700000006.000001', text: '', mentionsTarget: false,
  }), now), 'ignored');
  assert.equal(tasks.find('reply')?.failureCode, 'REQUEST_DELETED');
  assert.equal(tasks.find('reply')?.status, 'CANCELLED');
});

test('작업 무효화 실패 시 inbox와 요청 개정도 함께 rollback한다', async (context) => {
  const { inbox, path } = await openInbox(context);
  inbox.receive(event(), now);
  const tasks = new SqliteTaskStore(path);
  tasks.close();
  const connection = new DatabaseSync(path);
  context.after(() => connection.close());
  connection.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)')
    .run('invalid', 'W_LOCAL', 'Ev_invalid', 'AWAITING_APPROVAL', '{ invalid json');
  const edited = event({ kind: 'edited', eventId: 'Ev_edit', revision: '1700000002.000001' });
  assert.throws(() => inbox.receive(edited, now));
  assert.equal(inbox.list()[0]?.revision, event().revision);
  assert.equal(inbox.pending()[0]?.event.eventId, event().eventId);
  connection.prepare('DELETE FROM tasks WHERE task_id = ?').run('invalid');
  assert.equal(inbox.receive(edited, now), 'accepted');
});

test('DB와 부속 파일의 symlink·hardlink를 거부하고 외부 파일을 보존한다', async (context) => {
  const directory = await temporaryDirectory(context);
  const outside = join(directory, 'outside.sqlite');
  await writeFile(outside, 'SYNTHETIC_OUTSIDE', { mode: 0o640 });
  const before = await readFile(outside);
  const beforeMode = (await stat(outside)).mode;
  let index = 0;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    for (const kind of ['symlink', 'hardlink']) {
      const data = join(directory, `data-${index++}`);
      await mkdir(data, { mode: 0o700 });
      const path = join(data, 'tasks.sqlite');
      const missing = join(directory, `missing-${index}`);
      if (kind === 'hardlink') await link(outside, `${path}${suffix}`);
      else await symlink(missing, `${path}${suffix}`);
      assert.throws(() => new SqliteSlackInbox(path, config), { code: 'UNSAFE_RUNTIME_FILE' });
      if (kind === 'symlink') await assert.rejects(lstat(missing), { code: 'ENOENT' });
    }
  }
  assert.deepEqual(await readFile(outside), before);
  assert.equal((await stat(outside)).mode, beforeMode);
});
