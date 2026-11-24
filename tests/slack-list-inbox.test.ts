import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      listId, itemId: 'RecTEST', commentId: '2.000001', text: '<@U_OWNER> [REDACTED_EMAIL]',
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
  assert.deepEqual(inbox.listMentions(now + 3).map(row => row.text), ['UPDATED <@U_OWNER>']);
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
