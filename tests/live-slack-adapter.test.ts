import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { LiveSlackAdapter } from '../src/adapters/live-slack.js';
import type { LiveClaim, LiveSlackConfig, LiveSource } from '../src/domain/live-slack.js';
import { createLivePlan, hashLiveContext, liveMaxResponseBytes, liveTestBody, liveTestRootText } from '../src/policy/live-slack-policy.js';

const now = new Date('2026-11-11T01:00:00.000Z');
const config: LiveSlackConfig = { policy: 'slack-live-test-v1', liveEnabled: true, workspaceId: 'T_SYNTHETIC', channelId: 'C_SYNTHETIC', threadTs: '1700000000.000001' };
const token = ['xoxb', 'SYNTHETIC', 'TEST', 'TOKEN'].join('-');
const root = { ts: config.threadTs, user: 'U_REQUESTER', text: liveTestRootText, reply_count: 0 };
const source = (): LiveSource => ({
  botId: 'B_SYNTHETIC', botUserId: 'U_BOT', rootRevision: config.threadTs,
  contextHash: hashLiveContext({ ts: root.ts, user: root.user, text: root.text, revision: root.ts }), observedAt: now.toISOString(),
});
const claim = (): LiveClaim => {
  const plan = createLivePlan(config, source(), `os-user:${process.getuid!()}`, now);
  const approvalId = randomUUID();
  return {
    task: { plan, status: 'SENDING', updatedAt: now.toISOString(), reason: null },
    approval: { approvalId, taskId: plan.taskId, ownerId: plan.ownerId, planHash: plan.planHash, planSnapshot: structuredClone(plan),
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), usedAt: now.toISOString(), revokedAt: null },
    attempt: { attemptId: randomUUID(), taskId: plan.taskId, approvalId, planHash: plan.planHash,
      status: 'SENDING', startedAt: now.toISOString(), finishedAt: null, receipt: null, reason: null },
    checkedAt: now.toISOString(),
  };
};
const json = (payload: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(payload), { status, headers });
type Phase = 'auth' | 'thread' | 'post';
const auth = (): Response => json({ ok: true, team_id: config.workspaceId, bot_id: source().botId, user_id: source().botUserId }, 200, { 'x-oauth-scopes': 'channels:history, chat:write' });
const thread = (): Response => json({ ok: true, has_more: false, messages: [root], response_metadata: { next_cursor: '' } });
const receipt = (): Record<string, unknown> => ({ ok: true, channel: config.channelId, ts: '1700000001.000001', message: {
  ts: '1700000001.000001', thread_ts: config.threadTs, user: source().botUserId, bot_id: source().botId, text: liveTestBody,
} });
const harness = (override?: (phase: Phase, init: RequestInit) => Response | Promise<Response> | undefined, clock: () => Date = () => now) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    assert.equal(typeof input, 'string');
    const url = String(input);
    requests.push({ url, init });
    const phase: Phase = url.endsWith('/auth.test') ? 'auth' : url.includes('/conversations.replies?') ? 'thread' : 'post';
    return await (override?.(phase, init) ?? (phase === 'auth' ? auth() : phase === 'thread' ? thread() : json(receipt())));
  };
  return { requests, adapter: new LiveSlackAdapter(token, { fetch: fakeFetch, clock }) };
};

test('live 비활성과 잘못된 설정은 네트워크를 호출하지 않는다', async () => {
  const { adapter, requests } = harness();
  await assert.rejects(adapter.capture({ ...config, liveEnabled: false }), { message: 'LIVE_DISABLED' });
  await assert.rejects(adapter.capture({ ...config, channelId: 'D_OTHER' }), { message: 'LIVE_INVALID_CONFIG' });
  assert.equal(requests.length, 0);
  assert.throws(() => new LiveSlackAdapter('private-invalid-token'), { message: 'LIVE_SLACK_INVALID_TOKEN' });
  assert.throws(() => new LiveSlackAdapter(`xoxb-${'A'.repeat(4096)}`), { message: 'LIVE_SLACK_INVALID_TOKEN' });
  assert.doesNotThrow(() => new LiveSlackAdapter(`xoxb-${'A'.repeat(300)}`));
});

test('auth identity·scope와 단일 원문을 조회하고 본문을 보관하지 않는 metadata만 반환한다', async () => {
  const { adapter, requests } = harness();
  assert.deepEqual(await adapter.capture(config), source());
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.init.method), ['POST', 'GET']);
  assert.equal(requests[0]?.url, 'https://slack.com/api/auth.test');
  const query = new URL(requests[1]!.url);
  assert.equal(query.origin, 'https://slack.com');
  assert.equal(query.pathname, '/api/conversations.replies');
  assert.deepEqual(Object.fromEntries(query.searchParams), { channel: config.channelId, ts: config.threadTs, limit: '2' });
  for (const request of requests) {
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.credentials, 'omit');
    assert.equal(new Headers(request.init.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(request.url.includes(token), false);
  }
  assert.equal(JSON.stringify(source()).includes(liveTestRootText), false);
});

test('다른 workspace·잘못된 bot/user·누락 scope는 원문 조회 이전에 차단한다', async () => {
  for (const payload of [
    { ok: true, team_id: 'T_OTHER', bot_id: 'B_SYNTHETIC', user_id: 'U_BOT' },
    { ok: true, team_id: config.workspaceId, bot_id: 'U_WRONG', user_id: 'U_BOT' },
    { ok: true, team_id: config.workspaceId, bot_id: 'B_SYNTHETIC', user_id: 'B_WRONG' },
    { ok: false, error: 'invalid_auth-private-token' },
  ]) {
    const { adapter, requests } = harness((phase) => phase === 'auth' ? json(payload, 200, { 'x-oauth-scopes': 'chat:write,channels:history' }) : undefined);
    await assert.rejects(adapter.capture(config), { message: 'LIVE_SLACK_IDENTITY_MISMATCH' });
    assert.equal(requests.length, 1);
  }
  for (const scopes of [undefined, '', 'chat:write', 'channels:history', 'chat:write.public,channels:history']) {
    const { adapter, requests } = harness((phase) => phase === 'auth'
      ? json({ ok: true, team_id: config.workspaceId, bot_id: 'B_SYNTHETIC', user_id: 'U_BOT' }, 200, scopes === undefined ? {} : { 'x-oauth-scopes': scopes }) : undefined);
    await assert.rejects(adapter.capture(config), { message: 'LIVE_SLACK_IDENTITY_MISMATCH' });
    assert.equal(requests.length, 1);
  }
});

test('새 reply·부분 페이지·잘못된 원문과 숨겨진 reply 신호를 거부한다', async () => {
  for (const payload of [
    { ok: true, has_more: true, messages: [root] },
    { ok: true, is_limited: true, messages: [root] },
    { ok: true, messages: [root], response_metadata: { next_cursor: 'NEXT' } },
    { ok: true, messages: [root, { ...root, ts: '1700000000.000002' }] },
    { ok: true, messages: [] },
    ...[
      { text: 'private-source-text' }, { ts: '1700000000.000002' }, { thread_ts: '1700000000.000002' },
      { subtype: 'bot_message' }, { bot_id: 'B_OTHER' }, { hidden: true }, { reply_count: 1 },
      { reply_users_count: 1 }, { reply_users: ['U_OTHER'] }, { latest_reply: '1700000000.000002' }, { edited: { ts: 'INVALID' } },
    ].map((patch) => ({ ok: true, messages: [{ ...root, ...patch }] })),
  ]) {
    const { adapter, requests } = harness((phase) => phase === 'thread' ? json(payload) : undefined);
    await assert.rejects(adapter.capture(config), (error: unknown) => error instanceof Error && /^LIVE_SLACK_(?:THREAD_CHANGED|INCOMPLETE_THREAD)$/.test(error.message));
    assert.equal(requests.length, 2);
  }
});

test('원문 편집 revision은 부동소수점 변환 없이 문맥 hash에 포함한다', async () => {
  const revision = '1700000000.00000000000000001234';
  const { adapter } = harness((phase) => phase === 'thread' ? json({ ok: true, messages: [{ ...root, edited: { ts: revision } }] }) : undefined);
  const result = await adapter.capture(config);
  assert.equal(result.rootRevision, revision);
  assert.equal(result.contextHash, hashLiveContext({ ts: root.ts, user: root.user, text: root.text, revision }));
  assert.notEqual(result.contextHash, source().contextHash);
});

test('소비된 live 승인만 고정 원래 스레드의 일반 텍스트 단건 POST로 전달한다', async () => {
  const { adapter, requests } = harness();
  const result = await adapter.post(claim());
  assert.deepEqual(result, { status: 'SENT', reason: null, receipt: { channelId: config.channelId, messageTs: '1700000001.000001', threadTs: config.threadTs } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(requests[0]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)) as unknown, {
    channel: config.channelId, thread_ts: config.threadTs, text: liveTestBody,
    reply_broadcast: false, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
  });
  assert.equal(JSON.stringify(result).includes(liveTestBody), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('미승인·위조·만료·취소·오래된 문맥은 POST 0회로 거부한다', async () => {
  const values: LiveClaim[] = [];
  const unclaimed = claim(); unclaimed.approval.usedAt = null; values.push(unclaimed);
  const mock = claim(); mock.task.plan.mode = 'mock' as 'live-test'; values.push(mock);
  const changed = claim(); changed.task.plan.config.channelId = 'C_OTHER'; values.push(changed);
  const expired = claim(); expired.approval.expiresAt = now.toISOString(); values.push(expired);
  const cancelled = claim(); cancelled.approval.revokedAt = now.toISOString(); values.push(cancelled);
  const pending = claim(); pending.task.status = 'APPROVED'; values.push(pending);
  const old = claim(); old.checkedAt = new Date(now.getTime() - 5_001).toISOString(); values.push(old);
  for (const value of values) {
    const { adapter, requests } = harness();
    assert.equal((await adapter.post(value)).status, 'NOT_SENT');
    assert.equal(requests.length, 0);
  }
});

test('같은 attempt의 동시·후속 호출은 POST를 한 번만 수행한다', async () => {
  const value = claim();
  const { adapter, requests } = harness();
  const results = await Promise.all([adapter.post(value), adapter.post(value)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['SENT', 'UNKNOWN']);
  assert.equal((await adapter.post(value)).status, 'UNKNOWN');
  assert.equal(requests.length, 1);
});

test('명시적인 Slack 거부와 429만 NOT_SENT이며 재시도하지 않는다', async () => {
  for (const response of [json({ ok: false, error: 'missing_scope' }), json({ ok: false, error: 'not_in_channel' }), new Response('unread-private-body', { status: 429 })]) {
    const { adapter, requests } = harness(() => response);
    const result = await adapter.post(claim());
    assert.equal(result.status, 'NOT_SENT');
    assert.equal(result.receipt, null);
    assert.equal(requests.length, 1);
  }
});

test('서버 오류·불확실한 거부·부분 성공 증거·malformed 응답은 UNKNOWN이다', async () => {
  for (const response of [
    json({ ok: false, error: 'fatal_error' }), json({ ok: false, error: 'internal_error' }),
    json({ ok: false, error: 'private-unknown-error' }), json({ ok: false, error: 'missing_scope', ts: '1700000001.000001' }),
    json({ ok: false, error: 'missing_scope', message: {} }), new Response('private-html', { status: 503 }),
    new Response('private-malformed-response'), json([]), json({ ok: true }, 202),
  ]) {
    const { adapter, requests } = harness(() => response);
    const result = await adapter.post(claim());
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.receipt, null);
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(result).includes('private-'), false);
  }
});

test('receipt의 channel·timestamp·thread·bot·user·본문을 모두 대조한다', async () => {
  for (const patch of [
    { channel: 'C_OTHER' }, { ts: config.threadTs }, { ts: '1699999999.999999' }, { ts: 'INVALID' },
    ...[{ thread_ts: '1700000000.000002' }, { bot_id: 'B_OTHER' }, { user: 'U_OTHER' }, { text: 'private-wrong-body' }, { ts: '1700000001.000002' },
      { subtype: 'thread_broadcast' }, { reply_broadcast: true }, { hidden: true }]
      .map((messagePatch) => ({ message: { ...(receipt().message as Record<string, unknown>), ...messagePatch } })),
  ]) {
    const { adapter, requests } = harness(() => json({ ...receipt(), ...patch }));
    const result = await adapter.post(claim());
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'LIVE_SLACK_RECEIPT_MISMATCH');
    assert.equal(requests.length, 1);
  }
});

test('redirect와 응답 상한을 거부하고 원시 오류를 결과에 반영하지 않는다', async () => {
  for (const override of [
    (): Response => new Response(null, { status: 302, headers: { location: 'https://example.invalid/private' } }),
    (): Response => new Response('small', { headers: { 'content-length': String(liveMaxResponseBytes + 1) } }),
    (): Response => new Response('x'.repeat(liveMaxResponseBytes + 1)),
    (): Response => { throw new Error(`${token} private-network-error`); },
  ]) {
    const { adapter, requests } = harness(override);
    const result = await adapter.post(claim());
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('POST 전 취소는 NOT_SENT이며 dispatch 후 취소·정지 스트림은 UNKNOWN이다', async () => {
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  const initial = harness();
  assert.equal((await initial.adapter.post(claim(), alreadyAborted.signal)).status, 'NOT_SENT');
  assert.equal(initial.requests.length, 0);
  for (const wait of [(): Promise<Response> => new Promise(() => {}), (): Response => new Response(new ReadableStream<Uint8Array>())]) {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const { adapter, requests } = harness((_phase, init) => { requestSignal = init.signal; return wait(); });
    const pending = adapter.post(claim(), controller.signal);
    while (requestSignal === undefined) await nextTurn();
    controller.abort();
    assert.equal((await pending).status, 'UNKNOWN');
    assert.equal(requestSignal?.aborted, true);
    assert.equal(requests.length, 1);
  }
});

test('fetch가 signal을 무시해도 요청 전체의 10초 제한을 강제한다', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, requests } = harness(() => new Promise<Response>(() => {}));
  const pending = adapter.post(claim());
  context.mock.timers.tick(10_000);
  const result = await pending;
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.reason, 'LIVE_SLACK_REQUEST_TIMEOUT');
  assert.equal(requests.length, 1);
});

test('조회 단계의 외부 오류·취소·잘못된 JSON도 고정 오류 코드만 노출한다', async () => {
  for (const response of [
    (): Response => { throw new Error(`${token} private-response`); },
    (): Response => new Response('private-response'),
    (): Response => new Response(null, { status: 302 }),
  ]) {
    const { adapter, requests } = harness(response);
    await assert.rejects(adapter.capture(config), (error: unknown) => error instanceof Error && /^LIVE_SLACK_[A-Z_]+$/.test(error.message));
    assert.equal(requests.length, 1);
  }
  const controller = new AbortController(); controller.abort();
  const { adapter, requests } = harness();
  await assert.rejects(adapter.capture(config, controller.signal), { message: 'LIVE_SLACK_REQUEST_CANCELLED' });
  assert.equal(requests.length, 0);
});
