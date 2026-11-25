import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import type { SlackReceiverConfig } from '../src/domain/slack.js';
import type { SlackListComment } from '../src/policy/slack-list-export.js';

const receiverConfig = {
  workspaceId: 'W_LOCAL', channelIds: ['C_TEST'], targetUserId: 'U_OWNER',
  liveReadEnabled: false, retentionHours: 1, maxPending: 10,
  thread: { maxMessages: 10, maxPages: 2, maxBytes: 16_384 },
};
const listId = 'F_TEST';
const config: SlackReceiverConfig = { ...receiverConfig, listId };
const now = Date.parse('2026-11-24T00:00:00Z');
const comment = (commentId: string, text = '합성 <@U_OWNER> 요청', mentionsTarget = true): SlackListComment => ({
  itemId: 'RecTEST', commentId, text, mentionsTarget,
});
const openDatabase = async (context: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-slack-list-inbox-')));
  const path = join(directory, 'tasks.sqlite');
  const connections = new Set<SqliteSlackInbox>();
  context.after(async () => {
    for (const connection of connections) connection.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = (options = config) => {
    const connection = new SqliteSlackInbox(path, options);
    connections.add(connection);
    return connection;
  };
  const close = (connection: SqliteSlackInbox) => {
    connection.close();
    connections.delete(connection);
  };
  return { path, open, close };
};

test('첫 스냅샷에 있는 댓글은 건너뛰고 새 댓글의 직접 멘션만 한 번 보관한다', async (context) => {
  const db = await openDatabase(context);
  const inbox = db.open();
  const history = [comment('1.000001', 'HISTORICAL_PRIVATE_TEXT'), comment('B', 'OTHER_PRIVATE_TEXT', false)];
  assert.deepEqual(inbox.applyListSnapshot(listId, history, now), { baseline: true, mentions: [] });
  db.close(inbox);
  const restarted = db.open();
  const current = [...history, comment('2.000001', '<@U_OWNER> private@example.com'),
    comment('C', 'NEVER_STORED_BODY', false)];
  const result = restarted.applyListSnapshot(listId, current, now + 1);
  assert.deepEqual(result, {
    baseline: false, mentions: [{
      listId, itemId: 'RecTEST', commentId: '2.000001',
      detectedAt: new Date(now + 1).toISOString(),
    }],
  });
  assert.deepEqual(db.open().applyListSnapshot(listId, current, now + 2).mentions, []);
  assert.deepEqual(restarted.listMentions(now + 2), result.mentions);
  assert.deepEqual(restarted.list(), []);
  assert.deepEqual(restarted.pending(), []);
  const bytes = await readFile(db.path);
  for (const privateText of ['HISTORICAL_PRIVATE_TEXT', 'OTHER_PRIVATE_TEXT', 'NEVER_STORED_BODY', 'private@example.com']) {
    assert.equal(bytes.includes(privateText), false);
  }
});

test('초기 실패는 기준점을 만들지 않으며 독립적인 리스트·사용자·워크스페이스만 보인다', async (context) => {
  const db = await openDatabase(context);
  const inbox = db.open();
  assert.throws(() => inbox.applyListSnapshot('F_OTHER', [], now), { code: 'SLACK_LIST_DENIED' });
  assert.throws(() => inbox.applyListSnapshot(listId, [comment('A'), comment('../invalid')], now),
    { code: 'SLACK_LIST_COMMENT_INVALID' });
  assert.deepEqual(inbox.applyListSnapshot(listId, [], now), { baseline: true, mentions: [] });
  assert.equal(inbox.applyListSnapshot(listId, [comment('A')], now + 1).mentions.length, 1);
  for (const options of [{ ...config, listId: 'F_OTHER' }, { ...config, workspaceId: 'W_OTHER' },
    { ...config, targetUserId: 'U_OTHER' }]) {
    const scoped = db.open(options);
    assert.deepEqual(scoped.listMentions(now + 2), []);
    assert.deepEqual(scoped.applyListSnapshot(options.listId!, [comment('A')], now + 2), { baseline: true, mentions: [] });
  }
  const { listId: omittedListId, ...withoutList } = config;
  assert.deepEqual(db.open(withoutList).listMentions(now + 2), []);
  assert.throws(() => db.open(withoutList).applyListSnapshot(omittedListId!, [], now), { code: 'SLACK_LIST_DENIED' });
});

test('기존 리스트에 두 번째 리스트를 추가하면 기준점과 같은 댓글 ID를 리스트별로 처리한다', async (context) => {
  const db = await openDatabase(context);
  const first = db.open();
  first.applyListSnapshot(listId, [], now);
  db.close(first);

  const secondListId = 'F_SECOND';
  const listIds = [listId, secondListId];
  const inbox = db.open({ ...receiverConfig, listIds });
  listIds.splice(1, 1, 'F_OTHER');
  assert.throws(() => inbox.applyListSnapshot('F_OTHER', [], now), { code: 'SLACK_LIST_DENIED' });
  const existing = comment('A');
  assert.deepEqual(inbox.applyListSnapshot(secondListId, [existing], now + 1), { baseline: true, mentions: [] });
  const shared = comment('B');
  const firstMentions = inbox.applyListSnapshot(listId, [shared], now + 2).mentions;
  const secondMentions = inbox.applyListSnapshot(secondListId, [existing, shared], now + 3).mentions;
  assert.deepEqual(firstMentions.map(row => [row.listId, row.commentId]), [[listId, 'B']]);
  assert.deepEqual(secondMentions.map(row => [row.listId, row.commentId]), [[secondListId, 'B']]);
  assert.deepEqual(inbox.listMentions(now + 3), [...secondMentions, ...firstMentions]);
  assert.deepEqual(inbox.applyListSnapshot(secondListId, [existing, shared], now + 4).mentions, []);
  assert.deepEqual(db.open().listMentions(now + 4), firstMentions);
  assert.deepEqual(inbox.listMentions(now + 3_600_002), secondMentions);
});

test('설정된 모든 리스트에서 최신 멘션 100개를 한 번에 조회한다', async (context) => {
  const db = await openDatabase(context);
  const secondListId = 'F_SECOND';
  const inbox = db.open({ ...receiverConfig, listIds: [listId, secondListId] });
  const comments = Array.from({ length: 60 }, (_, index) => comment(String(index)));
  inbox.applyListSnapshot(listId, [], now);
  inbox.applyListSnapshot(secondListId, [], now);
  const first = inbox.applyListSnapshot(listId, comments, now + 1).mentions;
  const second = inbox.applyListSnapshot(secondListId, comments, now + 2).mentions;
  assert.deepEqual(inbox.listMentions(now + 2), [...first, ...second].reverse().slice(0, 100));
});

test('완료된 스냅샷에서 수정과 삭제를 반영해도 기존 댓글을 새 멘션으로 발행하지 않는다', async (context) => {
  const db = await openDatabase(context);
  const inbox = db.open();
  const original = comment('A', 'INITIAL_NONMENTION', false);
  inbox.applyListSnapshot(listId, [original], now);
  const second = [comment('A'), comment('B'), comment('C'), comment('D'), { ...comment('B'), itemId: 'RecOTHER' }];
  assert.equal(inbox.applyListSnapshot(listId, second, now + 2).mentions.length, 4);
  assert.deepEqual(inbox.applyListSnapshot(listId, [], now + 1).mentions, []);
  assert.equal(inbox.listMentions(now + 2).length, 4);
  const updated = [comment('A'), comment('B', 'UPDATED <@U_OWNER>'), comment('C', 'UNTAGGED_TEXT', false)];
  assert.deepEqual(inbox.applyListSnapshot(listId, updated, now + 3).mentions, []);
  assert.deepEqual(inbox.listMentions(now + 3).map(row => row.commentId), ['B']);
  assert.ok(!(await readFile(db.path)).includes('UPDATED <@U_OWNER>'));
  assert.deepEqual(inbox.applyListSnapshot(listId, second, now + 4).mentions, []);
  assert.deepEqual(inbox.listMentions(now + 4).map(row => row.commentId), ['B']);
});

test('보관 기한에 조회와 정기 정리로 본문을 지우고 재시작 뒤 같은 멘션을 되살리지 않는다', async (context) => {
  const db = await openDatabase(context);
  const inbox = db.open();
  inbox.applyListSnapshot(listId, [], now);
  inbox.applyListSnapshot(listId, [comment('A')], now + 1);
  inbox.applyListSnapshot(listId, [comment('A'), comment('B')], now + 2);
  const expiry = now + 3_600_001;
  assert.deepEqual(inbox.listMentions(expiry).map(row => row.commentId), ['B']);
  assert.equal(inbox.prune(new Date(expiry + 1)), 1);
  db.close(inbox);
  const restarted = db.open();
  assert.deepEqual(restarted.applyListSnapshot(listId, [comment('A'), comment('B')], expiry + 5).mentions, []);
  assert.deepEqual(restarted.listMentions(expiry + 5), []);
});

test('기존 DB의 마지막 댓글부터 누락 답글을 복구하며 더 최신 내보내기와 재시작도 중복 알림을 만들지 않는다', async (context) => {
  const db = await openDatabase(context);
  const thread = { itemId: 'RecTEST', threadTs: '9.000000' };
  const older = comment('9.999999');
  const saved = comment('10.000001');
  const missing = comment('10.000002', '<@U_OWNER> private@example.com');
  const duplicate = comment('10.000003');
  const old = db.open();
  old.applyListSnapshot(listId, [older, saved], now);
  db.close(old);

  // 이전 배포에는 커서 테이블과 직접 수집 표시 열이 없었다.
  const legacy = new DatabaseSync(db.path);
  legacy.exec('DROP TABLE slack_list_threads; ALTER TABLE slack_list_comments DROP COLUMN pending_export');
  legacy.close();

  const inbox = db.open();
  const exported = [older, saved, duplicate];
  const applyExport = (receiver: SqliteSlackInbox, time: number) => receiver.applyListSnapshot(listId, exported, time, [thread]);
  assert.deepEqual(applyExport(inbox, now + 1).mentions.map(mention => mention.commentId), [duplicate.commentId]);
  assert.equal(inbox.getListThreadCursor(listId, thread.itemId, thread.threadTs), saved.commentId);
  const notices = inbox.applyListThreadReplies(listId, thread.itemId, thread.threadTs, saved.commentId, [missing, duplicate], now + 2);
  assert.deepEqual(notices.map(row => row.commentId), [missing.commentId]);
  db.close(inbox);

  const restored = db.open();
  assert.equal(restored.getListThreadCursor(listId, thread.itemId, thread.threadTs), duplicate.commentId);
  assert.deepEqual(restored.applyListThreadReplies(listId, thread.itemId, thread.threadTs, saved.commentId, [missing, duplicate], now + 3), []);
  assert.equal(applyExport(restored, now + 4).mentions.length, 0);
  assert.deepEqual(restored.listMentions(now + 4).map(row => row.commentId), [missing.commentId, duplicate.commentId]);
  // 직접 받은 댓글이 나중에 내보내기에 포함되면 이후 편집·삭제와 보관 정책도 기존과 같다.
  assert.deepEqual(restored.applyListSnapshot(listId, [...exported, missing], now + 5, [thread]).mentions, []);
  assert.deepEqual(applyExport(restored, now + 6).mentions, []);
  assert.deepEqual(restored.listMentions(now + 6).map(row => row.commentId), [duplicate.commentId]);
});

test('초기 관찰 이전 답글을 알리지 않으며 실패한 직접 조회 페이지가 일부 저장되거나 커서를 이동시키지 않는다', async (context) => {
  const db = await openDatabase(context);
  const inbox = db.open();
  const thread = { itemId: 'RecTEST', threadTs: '1.000000' };
  inbox.applyListSnapshot(listId, [comment('2.000001')], 3_123, [thread]);
  const cursor = inbox.getListThreadCursor(listId, thread.itemId, thread.threadTs)!;
  assert.equal(cursor, '3.123000');
  const commit = (comments: SlackListComment[]) =>
    inbox.applyListThreadReplies(listId, thread.itemId, thread.threadTs, cursor, comments, 10_000);
  assert.throws(() => commit([comment('4.000000'), comment('3.122999')]));
  assert.throws(() => commit([comment('4.000000'), { ...comment('5.000000'), itemId: 'RecOTHER' }]));
  assert.throws(() => commit([comment('4.000000'), comment('5.000000', 'x'.repeat(16_385))]));
  assert.deepEqual(commit([]), []);
  assert.deepEqual(inbox.listMentions(10_000), []);
  assert.equal(inbox.getListThreadCursor(listId, thread.itemId, thread.threadTs), cursor);
  const first = commit([comment('4.000000'), comment('5.000000', '비멘션', false)]);
  assert.deepEqual(first.map(row => row.commentId), ['4.000000']);
  assert.equal(inbox.getListThreadCursor(listId, thread.itemId, thread.threadTs), '5.000000');
  assert.deepEqual(inbox.listMentions(3_610_000), []);
  assert.deepEqual(inbox.applyListSnapshot(listId, [comment('4.000000')], 3_611_000, [thread]).mentions, []);
  assert.deepEqual(inbox.listMentions(3_611_000), []);
});

test('등록이 삭제·교체된 항목과 다른 사용자·리스트의 오래된 응답은 쓰지 않는다', async (context) => {
  const db = await openDatabase(context);
  const inbox = db.open();
  const thread = { itemId: 'RecTEST', threadTs: '1.000000' };
  const replacement = { ...thread, threadTs: '7.000000' };
  inbox.applyListSnapshot(listId, [], 2_000, [thread]);
  assert.throws(() => inbox.applyListSnapshot(listId, [], 7_100, [thread, { ...thread, itemId: 'RecOTHER' }]));
  assert.equal(inbox.applyListThreadReplies(listId, thread.itemId, thread.threadTs, '2.000000', [comment('3.000001')], 4_000).length, 1);
  const oldCursor = inbox.getListThreadCursor(listId, thread.itemId, thread.threadTs)!;
  inbox.applyListSnapshot(listId, [], 7_200, [replacement]);
  assert.equal(inbox.getListThreadCursor(listId, thread.itemId, thread.threadTs), null);
  assert.deepEqual(inbox.listMentions(7_200), []);
  assert.deepEqual(inbox.applyListThreadReplies(listId, thread.itemId, thread.threadTs, oldCursor, [comment('8.000001')], 8_000), []);
  const cursor = inbox.getListThreadCursor(listId, thread.itemId, replacement.threadTs)!;
  assert.equal(cursor, replacement.threadTs);
  const otherUser = db.open({ ...config, targetUserId: 'U_OTHER' });
  assert.equal(otherUser.getListThreadCursor(listId, thread.itemId, replacement.threadTs), null);
  assert.deepEqual(otherUser.applyListThreadReplies(listId, thread.itemId, replacement.threadTs, cursor, [comment('8.000001')], 8_000), []);
  assert.throws(() => inbox.getListThreadCursor('F_OTHER', thread.itemId, replacement.threadTs), { code: 'SLACK_LIST_DENIED' });
  inbox.applyListSnapshot(listId, [], 8_000, []);
  assert.deepEqual(inbox.applyListThreadReplies(listId, thread.itemId, replacement.threadTs, cursor, [comment('8.000001')], 8_001), []);
  assert.deepEqual(inbox.listMentions(8_001), []);
});
