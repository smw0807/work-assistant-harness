import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from '../src/domain/errors.js';
import { parseSlackListComments } from '../src/policy/slack-list-export.js';

const listId = 'F_SAMPLE';
const target = 'U_OWNER';
const mentioned = '<@U_OWNER>';
const comment = (text: string, extra: Record<string, unknown> = {}) =>
  ({ user: 'U_COLLEAGUE', ts: '1795000000.000001', text, ...extra });
const item = (thread: unknown, extra: Record<string, unknown> = {}) => ({ id: 'Rec_SAMPLE', thread, ...extra });
const parse = (items: unknown[]) => parseSlackListComments({ list_id: listId, items }, listId, target);
const fails = (call: () => unknown) =>
  assert.throws(call, (error: unknown) => error instanceof HarnessError && error.code === 'SLACK_LIST_EXPORT_SCHEMA');
const rich = (type: string, elements: unknown[]) => ({ type: 'rich_text', elements: [{ type, elements }] });

test('a real mention in a comment is scoped to its item, redacted, and preserves the full timestamp', () => {
  const mentions = parse([item({ messages: [
    comment('확인 부탁해요 <@U_OWNER> test@example.test'),
    comment('다른 사람 <@U_OTHER>', { ts: '1795000000.000002' }),
  ] }, { fields: [{ type: 'user', user: [target] }, { text: mentioned }],
    subtasks: [item([comment('이것도 확인해요 <@U_OWNER|담당자>')], { id: 'Rec_CHILD' })] })]);
  assert.deepEqual(mentions, [
    { itemId: 'Rec_SAMPLE', commentId: '1795000000.000001', mentionsTarget: true, text: '확인 부탁해요 <@U_OWNER> [REDACTED_EMAIL]' },
    { itemId: 'Rec_SAMPLE', commentId: '1795000000.000002', mentionsTarget: false, text: '' },
    { itemId: 'Rec_CHILD', commentId: '1795000000.000001', mentionsTarget: true, text: '이것도 확인해요 <@U_OWNER|담당자>' },
  ]);
  const nested = { list: { id: listId, items: [{ id: 'Rec_OTHER', comments: [{ id: 'MSG_1', user_id: 'U_OTHER', text: mentioned }] }] } };
  assert.equal(parseSlackListComments(nested, listId, target)[0]?.commentId, 'MSG_1');
});

test('display names, quoted mentions, code, self-mentions and bot messages are ignored', () => {
  for (const text of ['@U_OWNER', 'U_OWNER', '@담당자', '<@U_OWNER2>', '&lt;@U_OWNER&gt;', '> <@U_OWNER>',
    '&gt; <@U_OWNER>', '>>> 인용\n<@U_OWNER>', '`<@U_OWNER>`', '```\n<@U_OWNER>\n```', '<https://example.test|@U_OWNER>']) {
    assert.deepEqual(parse([item([comment(text)])])[0]?.text, '');
  }
  for (const extra of [{ user: target }, { bot_id: 'B_SAMPLE' }, { bot_profile: {} }, { hidden: true }]) {
    assert.equal(parse([item([comment(mentioned, extra)])])[0]?.mentionsTarget, false);
  }
  assert.equal(parse([item([comment('> 인용\n<@U_OWNER> 실제 요청')])])[0]?.mentionsTarget, true);
});

test('rich user tokens override fallback text and do not inspect attachments, code or quoted sections', () => {
  const user = { type: 'user', user_id: target };
  for (const block of [rich('rich_text_quote', [user]), rich('rich_text_preformatted', [user]),
    rich('rich_text_section', [{ type: 'text', text: mentioned }]),
    rich('rich_text_section', [{ ...user, style: { code: true } }])]) {
    assert.equal(parse([item([comment(mentioned, { blocks: [block], attachments: [{ text: mentioned }] })])])[0]?.mentionsTarget, false);
  }
  const listBlock = rich('rich_text_list', [{ type: 'rich_text_section', elements: [user, { type: 'text', text: ' 확인' }] }]);
  assert.equal(parse([item([comment('', { blocks: [listBlock] })])])[0]?.text, '<@U_OWNER> 확인');
});

test('exported rich_text identifies direct mentions and only falls back to plain text for an empty block array', () => {
  const user = { type: 'user', user_id: target };
  const section = { type: 'rich_text_section', elements: [user, { type: 'text', text: ' 확인' }] };
  const parseRich = (richText: unknown, text = mentioned, extra: Record<string, unknown> = {}) =>
    parse([item([{ ts: '1795000000.000001', user_id: 'U_COLLEAGUE', text, rich_text: richText, ...extra }])])[0]!;
  assert.equal(parseRich([rich('rich_text_list', [section])], '').text, '<@U_OWNER> 확인');
  for (const block of [rich('rich_text_quote', [user]), rich('rich_text_preformatted', [user]),
    rich('rich_text_section', [{ ...user, style: { code: true } }]),
    rich('rich_text_section', [{ type: 'text', text: mentioned }])]) {
    assert.equal(parseRich([block]).mentionsTarget, false);
  }
  assert.equal(parseRich([], mentioned).mentionsTarget, true);
  assert.equal(parseRich([], '업무 기록', { files: [{ text: mentioned }] }).mentionsTarget, false);
  for (const malformed of [null, {}, [null], [{ type: 'unknown_block' }], [{ type: 'rich_text' }]]) {
    fails(() => parseRich(malformed));
  }
  fails(() => parseRich([], mentioned, { blocks: [rich('rich_text_quote', [user])] }));
});

test('a wrong list, incomplete threads, unknown layouts or oversize data cannot advance the snapshot', () => {
  for (const items of [
    [{ id: 'Rec_SAMPLE', fields: [{ text: mentioned }] }], [item([{ user: target, text: mentioned }])],
    [item({ messages: [], has_more: true })], [item({ comments: 'broken' })],
    [item([], { has_more: true })], [item([], { reply_count: 2 })], [item({ replies: [], reply_count: 1 })],
    [item([], { list_id: 'F_OTHER' })], [item([]), item([])], [item([comment('hi'), comment('hi')])],
    [item([comment(mentioned, { ts: 'invalid-secret' })])], [item([comment('가'.repeat(22_000))])],
    [item([], { subtasks: new Array(5_001).fill({}) })], [item(new Array(20_001).fill({}))],
  ]) fails(() => parse(items));
  fails(() => parseSlackListComments({ list_id: 'F_OTHER', items: [] }, listId, target));
  fails(() => parseSlackListComments({ list_id: listId, list: { id: 'F_OTHER' }, items: [] }, listId, target));
  fails(() => parseSlackListComments({ items: [] }, listId, target));
  assert.deepEqual(parse([{ id: 'Rec_NO_REPLY', reply_count: 0 }]), []);
});

test('hierarchical rows can omit empty threads when the snapshot identifies its list and thread layout', () => {
  const rows = [{ id: 'Rec_EMPTY', list_id: listId, thread: null }, { id: 'Rec_PARENT', list_id: listId,
    subtasks: [item({ ...comment('시작'), replies: [comment(mentioned, { ts: '1795000000.000002' })] })] }];
  for (const input of [{ rows }, { id: listId, rows }, { list: { id: listId, rows } }]) {
    const comments = parseSlackListComments(input, listId, target);
    assert.deepEqual(comments.map(value => value.mentionsTarget), [false, true]);
  }
  assert.deepEqual(parseSlackListComments({ id: listId, options: { include_threads: true }, rows: [{ id: 'Rec_EMPTY' }] }, listId, target), []);
  for (const input of [{ rows: [] }, { rows: [{ id: 'Rec_EMPTY' }] }, { rows: [rows[0]] }, { rows: [{ ...rows[0], list_id: 'F_OTHER' }] },
    { list_id: listId, rows, threads: {} }, { list_id: listId, rows, items: [] }, { id: listId, rows, has_more: true },
    { id: listId, rows, metadata: { include_threads: false } }, { id: listId, rows: [{ id: 'Rec_EMPTY', reply_count: 1 }, rows[1]] }]) {
    fails(() => parseSlackListComments(input, listId, target));
  }
});

test('returned text is UTF-8 bounded after redaction and never contains a split codepoint', () => {
  assert.equal(parse([item([comment('<@U_OWNER> xoxe-1-synthetic-refresh-token')])])[0]?.text, '<@U_OWNER> [REDACTED]');
  const text = 'Bearer synthetictoken123 <@U_OWNER> ' + '🙂'.repeat(2_000);
  const result = parse([item([comment(text)])])[0]!;
  assert.equal(result.mentionsTarget, true);
  assert.match(result.text, /^\[REDACTED\] <@U_OWNER>/);
  assert.ok(Buffer.byteLength(result.text) <= 2_048);
  assert.ok(!result.text.includes('\ufffd'));
});
