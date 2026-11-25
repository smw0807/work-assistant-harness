import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import type { SlackCollectedRequest, SlackMessageChange, SlackReceiverConfig, SlackThreadSnapshot } from '../src/domain/slack.js';
import { hashSlackAnalysisSource } from '../src/policy/slack-analysis.js';

const config: SlackReceiverConfig = { workspaceId: 'TTEST', channelIds: ['CCHAT'], listId: 'FTEST', listAnalysisEnabled: true,
  targetUserId: 'UOWNER', retentionHours: 1, maxPending: 10, liveReadEnabled: true, thread: { maxMessages: 10, maxPages: 2, maxBytes: 8192 } };
const time = new Date('2026-11-25T00:00:00.000Z');
const channelBody = '<@UOWNER> SOURCE_PRIVATE_CHANNEL_TEXT';
const listBody = '<@UOWNER> SOURCE_PRIVATE_LIST_TEXT';
const rootBody = 'SOURCE_PRIVATE_THREAD_ROOT';
const event: SlackMessageChange = { kind: 'created', eventId: 'ECHANNEL', workspaceId: 'TTEST', channelId: 'CCHAT',
  messageTs: '2.000001', threadTs: '1.000001', requesterId: 'UOTHER', revision: '2.000001', text: channelBody, mentionsTarget: true };
const snapshot = (body: string): SlackThreadSnapshot => ({ messages: [
  { ts: event.threadTs, user: 'UAUTHOR', text: rootBody }, { ts: event.messageTs, user: event.requesterId, text: body },
], complete: true, reason: null });
const runtime = async (context: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-source-metadata-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'tasks.sqlite');
};
const receiveList = (inbox: SqliteSlackInbox) => {
  const binding = { itemId: 'RecA', threadTs: event.threadTs };
  inbox.applyListSnapshot('FTEST', [], time.getTime() - 1, [binding], true);
  inbox.applyListSnapshot('FTEST', [{ itemId: binding.itemId, commentId: event.messageTs, mentionsTarget: true, text: listBody }],
    time.getTime(), [binding], true);
  inbox.refreshListAnalysisThread('FTEST', binding.itemId, binding.threadTs,
    { thread: snapshot(listBody), mentionTs: [event.messageTs] }, time.getTime());
};

test('채널과 리스트의 검증된 원문은 커밋 후 메모리로만 전달하고 새 DB 파일에는 기록하지 않는다', async context => {
  const path = await runtime(context);
  const delivered: string[] = [];
  const inbox = new SqliteSlackInbox(path, config, request => {
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const table = request.listItemId ? 'slack_list_analysis_requests' : 'slack_requests';
      const row = reader.prepare(`SELECT payload FROM ${table} WHERE message_ts = ?`).get(request.messageTs);
      const metadata = JSON.parse(String(row?.payload)) as SlackCollectedRequest;
      assert.equal(metadata.sourceHash, hashSlackAnalysisSource(request, config));
      assert.equal(metadata.messageCount, 2);
      assert.equal(metadata.text, '');
      assert.deepEqual(metadata.thread, { messages: [], complete: true, reason: null });
      assert.deepEqual(request.thread, snapshot(request.listItemId ? listBody : channelBody));
      assert.equal('sourceHash' in request, false);
      delivered.push(request.text);
    } finally { reader.close(); }
  });
  context.after(() => inbox.close());
  inbox.receive(event, time);
  const pendingBytes = await readFile(path);
  assert.ok(!pendingBytes.includes(channelBody));
  assert.equal(inbox.pending()[0]?.event.text, '');
  inbox.claim(event.eventId, event.workspaceId);
  inbox.complete(event, snapshot(channelBody), time);
  receiveList(inbox);
  inbox.refreshListAnalysisThread('FTEST', 'RecA', event.threadTs, { thread: snapshot(listBody), mentionTs: [event.messageTs] }, time.getTime());
  assert.deepEqual(delivered, [channelBody, listBody]);
  const file = await readFile(path);
  for (const text of [channelBody, listBody, rootBody]) assert.ok(!file.includes(text));
});

test('IPC 포화는 거부된 개정만 차단하며 채널과 리스트에 분석 미전달 사유가 남는다', async context => {
  const path = await runtime(context);
  const inbox = new SqliteSlackInbox(path, config, () => false);
  context.after(() => inbox.close());
  inbox.receive(event, time);
  inbox.claim(event.eventId, event.workspaceId);
  inbox.complete(event, snapshot(channelBody), time);
  receiveList(inbox);
  for (const request of [inbox.list()[0], inbox.findListAnalysisRequest('FTEST', event.messageTs, time.getTime())]) {
    assert.equal(request?.status, 'BLOCKED');
    assert.equal(request?.failureCode, 'SLACK_ANALYSIS_QUEUE_FULL');
    assert.equal(request?.sourceHash, undefined);
    assert.equal(request?.thread, null);
  }
});

test('다른 세션의 대기 이벤트와 수신 본문이 변경된 문맥은 메모리 분석으로 전달되지 않는다', async context => {
  const path = await runtime(context);
  const original = new SqliteSlackInbox(path, config);
  original.receive(event, time);
  original.close();
  const inbox = new SqliteSlackInbox(path, config, () => assert.fail('이전 세션 또는 수정된 입력이 전달됨'));
  context.after(() => inbox.close());
  inbox.claim(event.eventId, event.workspaceId);
  inbox.complete(event, snapshot(channelBody), time);
  const edited: SlackMessageChange = { ...event, kind: 'edited', eventId: 'EEDIT', revision: '3.000001' };
  inbox.receive(edited, time);
  inbox.claim(edited.eventId, edited.workspaceId);
  inbox.complete(edited, snapshot('<@UOWNER> CHANGED'), time);
  assert.equal(inbox.list()[0]?.sourceHash, undefined);
});
