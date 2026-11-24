import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSlackListComments, parseSlackListReplyPage, parseSlackListSnapshot, parseSlackListThreadBindings } from '../src/policy/slack-list-export.js';

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

test('중첩 항목과 댓글이 생략된 항목도 등록된 스레드 시각으로 연결한다', () => {
  const child = { record: listRecord('RecCHILD', childThreadTs), children: [] };
  const parent = { record: listRecord('RecPARENT', parentThreadTs), thread: [message(target)], children: [child] };
  const data = { ...snapshot([parent]), meta: completeMeta };
  const threads = [{ itemId: 'RecPARENT', threadTs: parentThreadTs }, { itemId: 'RecCHILD', threadTs: childThreadTs }];
  assert.deepEqual(parseSlackListSnapshot(data, listId, target), { threads, comments: parse(data) });
  const rows = [{ id: 'RecPARENT', thread_ts: parentThreadTs, comments: [message(target)],
    subtasks: [{ id: 'RecCHILD', thread_ts: childThreadTs, comment_count: 0 }] }];
  for (const name of ['items', 'rows']) {
    assert.deepEqual(parseSlackListSnapshot({ list_id: listId, [name]: rows }, listId, target).threads, threads);
  }
});

test('같은 스레드를 두 항목에 연결하거나 잘못된 시각으로 조회하지 않는다', () => {
  const first = { record: listRecord('RecFIRST', parentThreadTs), thread: [], children: [] };
  for (const threadTs of [parentThreadTs, parentThreadTs + '0', 123, 'bad', '1.2&channel=COTHER']) {
    const second = { ...first, record: { ...first.record, id: 'RecSECOND', thread_ts: threadTs } };
    assert.throws(() => parseSlackListSnapshot(snapshot([first, second]), listId, target), { code: 'SLACK_LIST_EXPORT_SCHEMA' });
  }
  // 메시지 본문이나 답글의 필드에서 직접 조회할 다른 스레드를 가져오지 않는다.
  const unbound = { record: { id: 'RecROW', list_id: listId }, children: [],
    thread: [{ ...message(target), thread_ts: parentThreadTs, channel: 'COTHER' }] };
  assert.deepEqual(parseSlackListSnapshot(snapshot([unbound]), listId, target).threads, []);
});

test('내보내기의 댓글이 잘리거나 손상되어도 명시된 바인딩만 검증할 수 있다', () => {
  const child = { record: listRecord('RecCHILD', childThreadTs), children: [], thread: [] };
  const parent = { record: listRecord('RecPARENT', parentThreadTs), children: [child], thread: [] };
  const expected = [{ itemId: 'RecPARENT', threadTs: parentThreadTs }, { itemId: 'RecCHILD', threadTs: childThreadTs }];
  for (const data of [
    { ...snapshot([parent]), meta: { ...completeMeta, complete: false, thread_replies_truncated: true } },
    snapshot([{ ...parent, reply_count: 5 }]),
    snapshot([{ ...parent, thread: [{ ts: messageTs, text: '작성자 없는 댓글' }] }]),
  ]) {
    assert.throws(() => parse(data), { code: 'SLACK_LIST_EXPORT_SCHEMA' });
    assert.deepEqual(parseSlackListThreadBindings(data, listId), expected);
  }
  for (const data of [
    { ...snapshot([parent]), list: { id: 'FOTHER' } },
    snapshot([{ ...parent, record: { ...parent.record, list_id: 'FOTHER' } }]),
    snapshot([{ ...parent, thread_ts: childThreadTs }]),
    snapshot([{ ...parent, children: undefined }]),
    snapshot([{ ...parent, children: [{ ...child, record: listRecord('RecCHILD', parentThreadTs) }] }]),
    { ...snapshot([parent]), rows: [] },
  ]) {
    assert.throws(() => parseSlackListThreadBindings(data, listId), { code: 'SLACK_LIST_EXPORT_SCHEMA' });
  }
});

test('직접 조회한 답글에 내보내기와 같은 멘션 판정과 마스킹을 적용하고 ts를 보존한다', () => {
  const comments = [
    { type: 'message', subtype: 'file_share', user: 'UAUTHOR', ts: messageTs, text: '<@UOWNER|합성> fake@example.test' },
    { ...message('UOTHER'), ts: '1795000000.000124', text: '<@UOWNER>' },
    { user: target, ts: '1795000000.000125', text: '<@UOWNER>' },
    { bot_id: 'BTEST', ts: '1795000000.000126', text: '<@UOWNER>' },
  ];
  const result = parseSlackListReplyPage(comments, 'RecROW', target);
  assert.deepEqual(result, parse(snapshot([{ record: listRecord('RecROW', parentThreadTs), thread: comments, children: [] }])));
  assert.deepEqual(result.map(comment => comment.text), ['<@UOWNER|합성> [REDACTED_EMAIL]', '', '', '']);
  for (const bad of [[{ ...message(target), ts: undefined, id: 'MSG' }], [comments[0], comments[0]]]) {
    assert.throws(() => parseSlackListReplyPage(bad, 'RecROW', target), { code: 'SLACK_LIST_EXPORT_SCHEMA' });
  }
});

test('직접 조회에서 시스템 메시지 뒤의 /me 답글도 처리하고 각 시각을 보존한다', () => {
  const system = { subtype: 'message_changed', type: 'message', ts: '1.1', message: { text: '<@UOWNER>' } };
  const action = { subtype: 'me_message', type: 'message', ts: '1.2', user: 'UAUTHOR', text: '<@UOWNER> 확인' };
  assert.deepEqual(parseSlackListReplyPage([system, action], 'RecROW', target), [
    { itemId: 'RecROW', commentId: '1.1', mentionsTarget: false, text: '' },
    { itemId: 'RecROW', commentId: '1.2', mentionsTarget: true, text: '<@UOWNER> 확인' },
  ]);
  for (const entry of [system, action]) {
    const exported = snapshot([{ record: listRecord('RecROW', parentThreadTs), thread: [entry], children: [] }]);
    assert.throws(() => parse(exported), { code: 'SLACK_LIST_EXPORT_SCHEMA' });
  }
});
