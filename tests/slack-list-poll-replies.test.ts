import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import { pollSlackLists } from '../src/application/poll-slack-list.js';
import { HarnessError } from '../src/domain/errors.js';

const scope = { workspaceId: 'TTEST', listIds: ['FFIRST', 'FSECOND'], targetUserId: 'UOWNER' };
const items = [
  { itemId: 'RecA', threadTs: '1.000001' },
  { itemId: 'RecB', threadTs: '1.000002' },
  { itemId: 'RecC', threadTs: '1.000003' },
];
const listItems = (listId: string) => listId === 'FFIRST' ? items.slice(0, 2) : items.slice(2);
const exported = (listId: string) => ({
  list_id: listId, items: listItems(listId).map(({ itemId, threadTs }) => ({ id: itemId, thread_ts: threadTs, thread: [] })),
});
const reply = (ts: string, text = '<@UOWNER> 합성 요청') => ({ ts, text, user: 'UAUTHOR' });

const registeredInbox = async (context: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-list-poll-')));
  const inbox = new SqliteSlackInbox(join(directory, 'tasks.sqlite'), {
    ...scope, channelIds: [], liveReadEnabled: false, retentionHours: 1, maxPending: 10,
    thread: { maxMessages: 10, maxPages: 2, maxBytes: 16_384 },
  });
  context.after(async () => { inbox.close(); await rm(directory, { recursive: true, force: true }); });
  for (const listId of scope.listIds) inbox.applyListSnapshot(listId, [], 2_000, listItems(listId));
  return inbox;
};

test('호출 제한 뒤 중단된 항목부터 재개하고 긴 스레드의 후속 페이지도 마지막 저장 시각부터 읽는다', async context => {
  const inbox = await registeredInbox(context);
  const stop = new AbortController();
  const reads: string[][] = [];
  const mentions: string[] = [];
  const failures: string[] = [];
  let cycle = 1;
  await pollSlackLists(scope, {
    read: async (_workspace, listId) => exported(listId),
    async readListThreadPage(_list, threadTs, oldest) {
      reads.push([threadTs, oldest]);
      if (threadTs === '1.000001' && oldest === '2.000000') return { messages: [reply('3.000001', '일반 답글')], hasMore: true };
      if (threadTs === '1.000002' && cycle === 1) throw new HarnessError('SLACK_RATE_LIMITED');
      return { messages: [reply('4.000001')], hasMore: false };
    },
  }, inbox, stop.signal, notice => {
    if (notice.status === 'mention') mentions.push(notice.itemId);
    if (notice.status === 'error') failures.push(notice.reason);
  }, async () => { if (++cycle > 2) stop.abort(); });
  assert.deepEqual(reads, [
    ['1.000001', '2.000000'], ['1.000002', '2.000000'],
    ['1.000002', '2.000000'], ['1.000003', '2.000000'], ['1.000001', '3.000001'],
  ]);
  assert.deepEqual(failures, ['SLACK_RATE_LIMITED']);
  assert.deepEqual(mentions, ['RecB', 'RecC', 'RecA']);
});

test('권한 오류는 해당 리스트의 직접 조회만 멈추고 취소된 다른 리스트의 페이지는 저장하지 않는다', async context => {
  const inbox = await registeredInbox(context);
  const stop = new AbortController();
  const reads: string[] = [];
  const notices: string[] = [];
  await pollSlackLists(scope, {
    read: async (_workspace, listId) => exported(listId),
    async readListThreadPage(listId, threadTs) {
      reads.push(threadTs);
      if (listId === 'FFIRST') throw new HarnessError('SLACK_THREAD_API_MISSING_SCOPE');
      stop.abort();
      return { messages: [reply('3.000001')], hasMore: false };
    },
  }, inbox, stop.signal, notice => { notices.push(notice.status === 'error' ? String(notice.method) : notice.status); });
  assert.deepEqual(reads, ['1.000001', '1.000003']);
  assert.deepEqual(notices, ['checked', 'checked', 'conversations.replies']);
  assert.deepEqual(inbox.listMentions(), []);
  for (const listId of scope.listIds) {
    for (const { itemId, threadTs } of listItems(listId)) assert.equal(inbox.getListThreadCursor(listId, itemId, threadTs), '2.000000');
  }
});

test('댓글이 잘린 내보내기는 이미 등록된 동일 항목의 스레드만 직접 읽고 새 바인딩을 등록하지 않는다', async context => {
  const inbox = await registeredInbox(context);
  const stop = new AbortController();
  const reads: string[] = [];
  const notices: string[] = [];
  await pollSlackLists(scope, {
    async read(_workspace, listId) {
      if (listId === 'FSECOND') return { ...exported(listId), list_id: 'FFOREIGN' };
      return { list_id: listId, items: [
        { id: 'RecA', thread_ts: '1.000001', reply_count: 1, thread: [] },
        { id: 'RecB', thread_ts: '1.999998', thread: [] },
        { id: 'RecNew', thread_ts: '1.999999', thread: [] },
      ] };
    },
    async readListThreadPage(_listId, threadTs) {
      reads.push(threadTs);
      return { messages: [reply('3.000001')], hasMore: false };
    },
  }, inbox, stop.signal, notice => {
    notices.push(notice.status === 'mention' ? notice.itemId : notice.status);
  }, async () => { stop.abort(); });
  assert.deepEqual(reads, ['1.000001']);
  assert.deepEqual(notices, ['error', 'error', 'RecA']);
  assert.equal(inbox.getListThreadCursor('FFIRST', 'RecA', '1.000001'), '3.000001');
  assert.equal(inbox.getListThreadCursor('FFIRST', 'RecB', '1.000002'), '2.000000');
  assert.equal(inbox.getListThreadCursor('FFIRST', 'RecNew', '1.999999'), null);
});
