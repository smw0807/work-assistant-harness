import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackReadClient } from '../src/adapters/slack-read-client.js';
import { HarnessError } from '../src/domain/errors.js';

const listId = 'FSYNTH', itemId = 'RecSYNTH', target = 'UOWNER';
const root = { type: 'message', subtype: 'list_record', user: 'USYSTEM', ts: '11.000001', text: '이 항목의 논의',
  thread_ts: '11.000001', list_record_id: itemId, channel: 'CSYNTH', reply_count: 1 };
const reply = { type: 'message', user: 'UAUTHOR', ts: '11.000002', thread_ts: root.ts, text: '<@UOWNER|담당자> 확인 부탁합니다.' };
const limits = { maxMessages: 20, maxPages: 5, maxBytes: 16_384 };
const signal = new AbortController().signal;
const readPages = (pages: unknown[], bounds = limits) => {
  const urls: URL[] = [];
  const client = new SlackReadClient({ webToken: 'offline', allowedListIds: [listId] }, {
    fetch: async (input, init) => {
      assert.equal(init?.redirect, 'error');
      urls.push(new URL(String(input)));
      return Response.json(pages[urls.length - 1]);
    },
  });
  return { urls, result: client.readListAnalysisThread(listId, itemId, root.ts, target, bounds, signal) };
};

test('등록한 파일 대화의 루트와 모든 답글을 순서대로 보존하고 직접 멘션만 식별한다', async () => {
  const parent = { ...root, reply_count: 5, latest_reply: '11.000006',
    list_record: { record: { record_id: itemId, fields: [{ text: '비공개 열 내용' }] } } };
  const context = '이전 대화 '.repeat(230) + ' a@example.test';
  const first = { ...reply, text: context };
  const quoted = { ...reply, ts: '11.000003', text: '', blocks: [{ type: 'rich_text', elements: [
    { type: 'rich_text_quote', elements: [{ type: 'user', user_id: target }, { type: 'text', text: ' 인용' }] },
  ] }] };
  const mention = { ...reply, ts: '11.000004', attachments: [{ text: '다른 첨부' }] };
  const own = { ...reply, ts: '11.000005', user: target, text: '내가 남긴 보충 <@UOWNER>' };
  const rich = { ...reply, ts: '11.000006', text: '담당자 확인', blocks: [{ type: 'rich_text', elements: [
    { type: 'rich_text_section', elements: [{ type: 'user', user_id: target }, { type: 'text', text: ' 영상을 올리면 ' },
      { type: 'text', text: 'TIMEOUT', style: { code: true } }, { type: 'text', text: '이 발생합니다.' }] },
    { type: 'rich_text_quote', elements: [{ type: 'text', text: '원래는 업로드 즉시 재생' }] },
    { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'status = 408' }] },
  ] }] };
  const { urls, result } = readPages([
    { ok: true, messages: [parent, first, quoted], has_more: true, response_metadata: { next_cursor: 'next+/=' } },
    { ok: true, messages: [parent, mention, own, rich], has_more: false },
  ]);
  const snapshot = await result;
  assert.equal(snapshot.thread.complete, true);
  assert.deepEqual(snapshot.mentionTs, [mention.ts, rich.ts]);
  assert.deepEqual(snapshot.thread.messages.map(m => m.text), [root.text, context.replace('a@example.test', '[REDACTED_EMAIL]'),
    '> <@UOWNER> 인용', '<@UOWNER> 확인 부탁합니다.', own.text,
    ['<@UOWNER> 영상을 올리면 `TIMEOUT`이 발생합니다.', '> 원래는 업로드 즉시 재생', '```', 'status = 408', '```'].join('\n')]);
  assert.deepEqual(snapshot.thread.messages.map(m => m.user), [root.user, first.user, quoted.user, mention.user, own.user, rich.user]);
  assert.equal(JSON.stringify(snapshot).includes('비공개 열 내용'), false);
  assert.equal(JSON.stringify(snapshot).includes('다른 첨부'), false);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.equal(url.origin + url.pathname, 'https://slack.com/api/conversations.replies');
    assert.equal(url.searchParams.get('channel'), 'CSYNTH');
    assert.equal(url.searchParams.get('ts'), root.ts);
    assert.equal(url.searchParams.has('oldest'), false);
  }
  assert.equal(urls[1]!.searchParams.get('cursor'), 'next+/=');
});

test('다른 항목·루트, 누락, 중복, 삭제와 읽기 실패에서 부분 근거를 반환하지 않는다', async () => {
  const invalidPages = [
    { messages: [reply] },
    { messages: [{ ...root, list_record_id: 'RecOTHER' }, reply] },
    { messages: [{ ...root, list_record: { record: { id: 'RecOTHER' } } }, reply] },
    { messages: [root, { ...reply, list_id: 'FOTHER' }] },
    { messages: [root, { ...reply, channel: 'COTHER' }] },
    { messages: [root, { ...reply, thread_ts: '11.000003' }] },
    { messages: [root, { ...reply, ts: '10.000001' }] },
    { messages: [{ ...root, reply_count: 2 }, reply, reply] },
    { messages: [{ ...root, latest_reply: '11.000009' }, reply] },
    { messages: [root] },
    { messages: [{ ...root, reply_count: '1' }, reply] },
    { messages: [{ ...root, reply_count: undefined }, reply] },
    { messages: [root, { ...reply, user: undefined }] },
    { messages: [root, { ...reply, subtype: 'tombstone' }] },
    { messages: [root, { ...reply, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section',
      elements: [{ type: 'user', user_id: target }, { type: 'unknown_visible_node' }] }] }] }] },
    { messages: [root, reply], is_limited: true },
    { messages: [root, reply], has_more: true },
    { messages: [root, reply], response_metadata: { next_cursor: {} } },
    { ok: false, error: 'missing_scope' },
  ];
  for (const page of invalidPages) {
    const { thread, mentionTs } = await readPages([{ ok: true, ...page }]).result;
    assert.equal(thread.complete, false);
    assert.ok(thread.reason);
    assert.deepEqual(thread.messages, []);
    assert.deepEqual(mentionTs, []);
  }
});

test('조회 한도·커서 순환이 확인되면 분석할 수 없고 허용하지 않은 리스트는 요청하지 않는다', async () => {
  const page = { ok: true, messages: [root], response_metadata: { next_cursor: 'next' } };
  const end = { ok: true, messages: [root, reply] };
  const cases: [unknown[], typeof limits, string][] = [
    [[end], { ...limits, maxMessages: 1 }, 'SLACK_THREAD_MESSAGE_LIMIT'],
    [[end], { ...limits, maxBytes: 8 }, 'SLACK_THREAD_BYTE_LIMIT'],
    [[page], { ...limits, maxPages: 1 }, 'SLACK_THREAD_PAGE_LIMIT'],
    [[page, page], limits, 'SLACK_THREAD_REPEATED_CURSOR'],
    [[page, { ...end, messages: [{ ...root, text: '바뀐 본문' }, reply] }], limits, 'SLACK_INVALID_RESPONSE'],
  ];
  for (const [pages, bounds, reason] of cases) {
    assert.deepEqual(await readPages(pages, bounds).result, { thread: { messages: [], complete: false, reason }, mentionTs: [] });
  }
  const client = new SlackReadClient({ webToken: 'offline', allowedListIds: [listId] }, { fetch: () => assert.fail() });
  await assert.rejects(client.readListAnalysisThread('FOTHER', itemId, root.ts, target, limits, signal),
    (error: unknown) => error instanceof HarnessError && error.code === 'SLACK_LIST_DENIED');
  assert.equal((await client.readListAnalysisThread(listId, itemId, root.ts, target, limits, AbortSignal.abort())).thread.reason,
    'SLACK_REQUEST_CANCELLED');
});
