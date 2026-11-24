import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSlackListComments } from '../src/policy/slack-list-export.js';

const listId = 'FSAMPLE';
const target = 'UOWNER';
const messageTs = '1795000000.000123';
const parentThreadTs = '1794999999.000001';
const childThreadTs = '1794999999.000002';

const listRecord = (id: string, threadTs: string) => ({
  id, list_id: listId, thread_ts: threadTs, fields: [{ text: '<@UOWNER>', user: [target] }],
});
const message = (userId: string) => ({
  ts: messageTs, user_id: 'UAUTHOR', text: `<@${userId}> 확인`,
  rich_text: [{ type: 'rich_text', elements: [
    { type: 'rich_text_section', elements: [{ type: 'user', user_id: userId }, { type: 'text', text: ' 확인' }] },
  ] }],
  files: [],
});
const snapshot = (records: unknown[]) => ({ list: { id: listId, title: '합성 리스트' }, records });
const parse = (input: unknown) => parseSlackListComments(input, listId, target);
const completeMeta = { complete: true, records_truncated: false, threads_truncated: false, thread_replies_truncated: false,
  message_threads_truncated: false, attachments_truncated: false, max_subtask_depth_exceeded: false };

test('내보낸 records와 children의 스레드 댓글을 각 record의 ID에 연결한다', () => {
  const child = { record: listRecord('RecCHILD', childThreadTs), thread: [message(target)], children: [] };
  const parent = { record: listRecord('RecPARENT', parentThreadTs), thread: [message('UOTHER')], children: [child] };
  const empty = { record: { id: 'RecEMPTY', list_id: listId, fields: [{ text: '<@UOWNER>' }] }, thread: [], children: [] };
  assert.deepEqual(parse(snapshot([parent, empty])), [
    { itemId: 'RecPARENT', commentId: messageTs, mentionsTarget: false, text: '' },
    { itemId: 'RecCHILD', commentId: messageTs, mentionsTarget: true, text: '<@UOWNER> 확인' },
  ]);
});

test('다른 리스트, 중복 항목·댓글, 누락된 스레드와 모호한 내보내기 구조를 거부한다', () => {
  const record = listRecord('RecSAMPLE', parentThreadTs);
  const row = { record, thread: [message(target)], children: [] };
  const exported = snapshot([row]);
  const invalid = {
    wrongList: { ...exported, list: { id: 'FOTHER' } },
    mixedRows: { ...exported, rows: [] },
    mixedItems: { ...exported, list: { id: listId, items: [] } },
    detachedThreads: { ...exported, threads: [message(target)] },
    incompleteExport: { ...exported, response_metadata: { next_cursor: 'synthetic-cursor' } },
    missingRecord: snapshot([{ thread: row.thread, children: [] }]),
    missingReplies: snapshot([{ record: { ...record, reply_count: 1 }, children: [] }]),
    wrongChildList: snapshot([{ ...row, children: [{ ...row, record: { ...record, id: 'RecCHILD', list_id: 'FOTHER' } }] }]),
    duplicateRecord: snapshot([{ ...row, children: [row] }]),
    duplicateMessage: snapshot([{ ...row, thread: [...row.thread, ...row.thread] }]),
  };
  for (const [name, input] of Object.entries(invalid)) {
    assert.throws(() => parse(input), { code: 'SLACK_LIST_EXPORT_SCHEMA' }, name);
  }
});

test('완전한 내보내기에서 생략된 빈 스레드를 처리하고 잘린 스냅샷은 거부한다', () => {
  const empty = { record: listRecord('RecEMPTY', parentThreadTs), children: [] };
  const full = { record: listRecord('RecFULL', childThreadTs), children: [], thread: [message(target)] };
  assert.deepEqual(parse({ ...snapshot([empty]), meta: completeMeta }), []);
  assert.equal(parse(snapshot([empty, full]))[0]?.itemId, 'RecFULL');
  assert.throws(() => parse(snapshot([empty])), { code: 'SLACK_LIST_EXPORT_SCHEMA' });
  const partial = { ...snapshot([empty, full]), meta: { ...completeMeta, complete: false } };
  assert.throws(() => parse(partial), { code: 'SLACK_LIST_EXPORT_SCHEMA' });
  for (const flag of Object.keys(completeMeta).filter(key => key !== 'complete')) {
    assert.throws(() => parse({ ...partial, meta: { ...completeMeta, [flag]: true } }), { code: 'SLACK_LIST_EXPORT_SCHEMA' }, flag);
  }
});
