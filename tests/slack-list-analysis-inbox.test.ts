import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import { pollSlackLists } from '../src/application/poll-slack-list.js';
import type { SlackListAnalysisThread, SlackReceiverConfig } from '../src/domain/slack.js';
import { HarnessError } from '../src/domain/errors.js';

const listId = 'FTEST', itemId = 'RecA', threadTs = '1.000000', ts = '3.000001';
const config: SlackReceiverConfig = { workspaceId: 'TTEST', channelIds: [], targetUserId: 'UOWNER', listIds: [listId],
  retentionHours: 1, maxPending: 10, liveReadEnabled: true, listAnalysisEnabled: true,
  thread: { maxMessages: 10, maxPages: 2, maxBytes: 16_384 } };
const scope = { workspaceId: config.workspaceId, listIds: [listId], targetUserId: config.targetUserId };
const binding = { itemId, threadTs };
const comment = (commentId: string) => ({ itemId, commentId, text: '<@UOWNER> 요청', mentionsTarget: true });
const reply = (messageTs: string) => ({ ts: messageTs, user: 'UAUTHOR', text: '<@UOWNER> 요청', thread_ts: threadTs });
const fullThread = (rootText = '합성 루트'): SlackListAnalysisThread => ({
  thread: { complete: true, reason: null, messages: [{ ts: threadTs, user: 'UAUTHOR', text: rootText },
    { ts, user: 'UAUTHOR', text: '<@UOWNER> 요청' }] }, mentionTs: [ts],
});
const open = async (context: TestContext, receiver = config) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-list-analysis-')));
  const inbox = new SqliteSlackInbox(join(directory, 'tasks.sqlite'), receiver);
  context.after(async () => { inbox.close(); await rm(directory, { recursive: true, force: true }); });
  return inbox;
};

for (const source of ['export', 'direct'] as const) {
  test(`${source}에서 처음 발견한 멘션의 스레드를 분석용으로 수집하고 루트 편집 시 기존 결과를 무효화한다`, async context => {
    const inbox = await open(context);
    inbox.applyListSnapshot(listId, [comment('1.100000')], 2000, [binding], true);
    const stop = new AbortController();
    let round = 0;
    const readRounds: number[] = [];
    const notifications: string[] = [];
    await pollSlackLists(scope, {
      read: async () => ({ list_id: listId, items: [{ id: itemId, thread_ts: threadTs,
        thread: source === 'export' || round > 0 ? [reply(ts)] : [] }] }),
      readListThreadPage: async (_list, _thread, oldest) => ({
        messages: oldest === '2.000000' ? [reply(ts)] : [], hasMore: false,
      }),
      readListAnalysisThread: async (list, item, thread) => {
        assert.deepEqual([list, item, thread], [listId, itemId, threadTs]);
        readRounds.push(round);
        return fullThread(round === 0 ? 'private@example.test' : '변경된 루트');
      },
    }, inbox, stop.signal, notice => { if (notice.status === 'mention') notifications.push(notice.commentId); },
    async () => {
      const request = inbox.findListAnalysisRequest(listId, ts);
      assert.equal(request?.status, round === 0 ? 'RECORDED' : 'INVALIDATED');
      if (round === 0) {
        assert.deepEqual(request?.thread?.messages, []);
        assert.equal(request?.messageCount, 2);
        assert.equal(request?.text, '');
        assert.equal(request?.requesterId, 'UAUTHOR');
      } else {
        assert.equal(request?.thread, null);
        assert.equal(request?.text, '');
      }
      if (++round === 3) stop.abort();
    });
    assert.deepEqual(readRounds, [0, 1]);
    assert.deepEqual(notifications, [ts]);
    assert.equal(inbox.findListAnalysisRequest(listId, '1.100000'), null);
  });
}

test('직접 멘션이 사라진 초기 스레드는 분석을 차단하고 재조회하지 않는다', async context => {
  const inbox = await open(context);
  inbox.applyListSnapshot(listId, [], 1000, [binding]);
  inbox.applyListSnapshot(listId, [comment(ts), comment('3.000002')], 2000, [binding], true);
  const snapshot = fullThread();
  snapshot.mentionTs = [];
  inbox.refreshListAnalysisThread(listId, itemId, threadTs, snapshot, 2100);
  const request = inbox.findListAnalysisRequest(listId, ts, 2200);
  assert.equal(request?.status, 'BLOCKED');
  assert.equal(request?.failureCode, 'REQUEST_MENTION_REMOVED');
  assert.equal(request?.thread, null);
  assert.deepEqual(inbox.listAnalysisThreads(listId, 2200), []);
  inbox.refreshListAnalysisThread(listId, itemId, threadTs, fullThread(), 2300);
  assert.deepEqual(inbox.findListAnalysisRequest(listId, ts, 2400), request);
  assert.equal(inbox.findListAnalysisRequest(listId, ts, 2000 + 3_600_000), null);
});

test('잘린 내보내기는 현재 바인딩의 전체 조회로 재검증하며 불완전한 재조회는 기존 문맥을 폐기한다', async context => {
  const inbox = await open(context);
  const time = Date.now();
  inbox.applyListSnapshot(listId, [], time - 2, [binding], true);
  inbox.applyListSnapshot(listId, [comment(ts)], time - 1, [binding], true);
  inbox.refreshListAnalysisThread(listId, itemId, threadTs, fullThread(), time);
  const stop = new AbortController();
  let round = 0;
  let reads = 0;
  await pollSlackLists(scope, {
    read: async () => ({ list_id: listId, items: [{ id: itemId, thread_ts: threadTs, reply_count: 2, thread: [] }] }),
    readListAnalysisThread: async () => {
      reads++;
      return round === 0 ? fullThread() : { thread: { complete: false, reason: 'SLACK_THREAD_PAGE_LIMIT', messages: [] }, mentionTs: [] };
    },
    readListThreadPage: async () => ({ messages: [], hasMore: false }),
  }, inbox, stop.signal, () => {}, async () => {
    const request = inbox.findListAnalysisRequest(listId, ts);
    assert.equal(request?.status, round === 0 ? 'RECORDED' : 'INVALIDATED');
    if (round === 1) assert.equal(request?.failureCode, 'SLACK_THREAD_PAGE_LIMIT');
    if (++round === 3) stop.abort();
  });
  assert.equal(reads, 2);
});

test('직접 조회의 일반 새 답글을 커서와 함께 반영하고 스냅샷에 이미 있던 답글은 유지한다', async context => {
  const inbox = await open(context);
  const alreadyRead = '4.000001', newReply = '5.000001';
  inbox.applyListSnapshot(listId, [], 2000, [binding]);
  inbox.applyListSnapshot(listId, [comment(ts)], 2100, [binding], true);
  const snapshot = fullThread();
  snapshot.thread.messages.push({ ts: alreadyRead, user: 'UOTHER', text: '일반 답글' });
  inbox.refreshListAnalysisThread(listId, itemId, threadTs, snapshot, 2200);
  const ordinary = (commentId: string) => ({ itemId, commentId, text: '', mentionsTarget: false });
  assert.deepEqual(inbox.applyListThreadReplies(listId, itemId, threadTs, '2.000000', [comment(ts), ordinary(alreadyRead)], 2300, true), []);
  assert.equal(inbox.findListAnalysisRequest(listId, ts, 2300)?.status, 'RECORDED');
  assert.deepEqual(inbox.applyListThreadReplies(listId, itemId, threadTs, alreadyRead, [ordinary(newReply)], 2400, true), []);
  assert.equal(inbox.getListThreadCursor(listId, itemId, threadTs), newReply);
  assert.equal(inbox.findListAnalysisRequest(listId, ts, 2400)?.failureCode, 'SLACK_LIST_THREAD_CHANGED');
  assert.equal(inbox.findListAnalysisRequest(listId, ts, 2400)?.thread, null);
});

test('내보내기와 직접 조회에서 멘션 표기가 달라도 전체 스레드가 같으면 결과를 유지한다', async context => {
  const inbox = await open(context);
  inbox.applyListSnapshot(listId, [], 2000, [binding]);
  inbox.applyListThreadReplies(listId, itemId, threadTs, '2.000000', [comment(ts)], 2100, true);
  inbox.refreshListAnalysisThread(listId, itemId, threadTs, fullThread(), 2200);
  inbox.applyListSnapshot(listId, [{ ...comment(ts), text: '<@UOWNER|표시명> 요청' }], 2300, [binding], true);
  const recorded = inbox.findListAnalysisRequest(listId, ts, 2300);
  assert.equal(recorded?.status, 'RECORDED');
  inbox.refreshListAnalysisThread(listId, itemId, threadTs, fullThread(), 2400);
  assert.deepEqual(inbox.findListAnalysisRequest(listId, ts, 2400), recorded);
  inbox.applyListSnapshot(listId, [{ ...comment(ts), mentionsTarget: false, text: '' }], 2500, [binding], true);
  assert.equal(inbox.findListAnalysisRequest(listId, ts, 2500)?.failureCode, 'REQUEST_MENTION_REMOVED');
});

for (const reason of ['SLACK_RATE_LIMITED', 'SLACK_THREAD_API_MISSING_SCOPE']) {
  test(`전체 조회의 ${reason} 오류를 같은 순회의 직접 조회와 공유하고 다음 리스트 내보내기를 계속한다`, async context => {
    const other = 'FSECOND';
    const twoLists = { ...scope, listIds: [listId, other] };
    const inbox = await open(context, { ...config, listIds: twoLists.listIds });
    const stop = new AbortController();
    const calls: string[] = [];
    for (const id of twoLists.listIds) inbox.applyListSnapshot(id, [], 2000, [binding]);
    await pollSlackLists(twoLists, {
      read: async (_workspace, id) => {
        calls.push(`export ${id}`);
        return { list_id: id, items: [{ id: itemId, thread_ts: threadTs, thread: [reply(ts)] }] };
      },
      readListAnalysisThread: async id => {
        calls.push(`full ${id}`);
        return id === listId ? { thread: { complete: false, reason, messages: [] }, mentionTs: [] } : fullThread();
      },
      readListThreadPage: async id => { calls.push(`page ${id}`); return { messages: [], hasMore: false }; },
    }, inbox, stop.signal, () => {}, async () => { stop.abort(); });
    const expected = [`export ${listId}`, `full ${listId}`, `export ${other}`];
    if (reason !== 'SLACK_RATE_LIMITED') expected.push(`full ${other}`, `page ${other}`);
    assert.deepEqual(calls, expected);
    assert.equal(inbox.findListAnalysisRequest(listId, ts)?.failureCode, reason);
    assert.equal(inbox.findListAnalysisRequest(other, ts)?.status, reason === 'SLACK_RATE_LIMITED' ? 'BLOCKED' : 'RECORDED');
  });
}

test('읽기 권한 오류는 수신 요청에 기록되고 ts·바인딩 부재는 항목 진단만 남긴다', async context => {
  const inbox = await open(context);
  inbox.applyListSnapshot(listId, [], 1000, [binding]);
  const stop = new AbortController();
  const notices: string[] = [];
  await pollSlackLists(scope, {
    read: async () => ({ list_id: listId, items: [
      { id: itemId, thread_ts: threadTs, thread: [reply(ts)] },
      { id: 'RecB', thread: [{ user: 'UAUTHOR', id: 'CommentID', text: '<@UOWNER>' }, reply('4.000001')] },
    ] }),
    readListThreadPage: async () => ({ messages: [], hasMore: false }),
    readListAnalysisThread: async () => { throw new HarnessError('SLACK_THREAD_API_MISSING_SCOPE'); },
  }, inbox, stop.signal, event => { if (event.status === 'error') notices.push(event.reason); }, async () => { stop.abort(); });
  assert.deepEqual(notices.sort(), ['SLACK_LIST_COMMENT_TS_MISSING', 'SLACK_LIST_THREAD_UNBOUND', 'SLACK_THREAD_API_MISSING_SCOPE']);
  assert.equal(inbox.findListAnalysisRequest(listId, ts)?.failureCode, 'SLACK_THREAD_API_MISSING_SCOPE');
  assert.equal(inbox.findListAnalysisRequest(listId, '4.000001')?.failureCode, 'SLACK_LIST_THREAD_UNBOUND');
  assert.equal(inbox.findListAnalysisRequest(listId, 'CommentID'), null);
  assert.equal(inbox.listMentions().length, 3);
});

test('재시작 중단·재바인딩·만료·분석 비활성은 이전 스냅샷이나 중복 수집을 허용하지 않는다', async context => {
  const inbox = await open(context);
  inbox.applyListSnapshot(listId, [], 1000, [binding]);
  inbox.applyListSnapshot(listId, [comment(ts)], 2000, [binding], true);
  inbox.recoverListAnalysis(listId, 2100);
  assert.equal(inbox.findListAnalysisRequest(listId, ts, 2200)?.failureCode, 'INTERRUPTED_REVIEW_REQUIRED');
  const newer = '4.000001';
  inbox.applyListSnapshot(listId, [comment(ts), comment(newer)], 2300, [binding], true);
  const snapshot = fullThread();
  snapshot.thread.messages.push({ ts: newer, text: '<@UOWNER> 추가 요청', user: 'UOTHER' });
  snapshot.mentionTs.push(newer);
  inbox.refreshListAnalysisThread(listId, itemId, threadTs, snapshot, 2400);
  inbox.applyListSnapshot(listId, [comment(ts), comment(newer)], 2500, [{ itemId, threadTs: '2.000002' }], true);
  inbox.refreshListAnalysisThread(listId, itemId, threadTs, snapshot, 2600);
  assert.equal(inbox.findListAnalysisRequest(listId, newer, 2700)?.failureCode, 'SLACK_LIST_THREAD_REBOUND');
  inbox.prune(new Date(2400 + 3_600_000));
  assert.deepEqual(inbox.applyListSnapshot(listId, [comment(ts), comment(newer)], 2500 + 3_600_000, [binding], true).mentions, []);
  const disabled = { ...config };
  delete disabled.listAnalysisEnabled;
  const offline = await open(context, disabled);
  offline.applyListSnapshot(listId, [], 1000, [binding]);
  offline.applyListSnapshot(listId, [comment(ts)], 2000, [binding], true);
  assert.equal(offline.findListAnalysisRequest(listId, ts, 2100), null);
});
