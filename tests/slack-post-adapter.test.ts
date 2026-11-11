import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { OfflineSlackHttp } from '../src/adapters/offline-slack-http.js';
import { DisabledSlackPostHttp, SlackPostMessageAdapter } from '../src/adapters/slack-post-message.js';
import type { OfflinePostIntent, SlackPostFixture } from '../src/domain/slack-post.js';
import type { SlackPostHttpPort, SlackPostHttpRequest } from '../src/ports/slack-post.js';
import { createOfflinePostIntent, defaultSlackPostConfig, offlinePostBody, offlineThreadMessages } from '../src/policy/slack-post-policy.js';

const now = new Date('2026-11-11T00:00:00.000Z');
const intent = (): OfflinePostIntent => createOfflinePostIntent('os-user:501', now);
const jsonResponse = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status });
const wrapOffline = (override?: (request: SlackPostHttpRequest) => Promise<Response> | undefined) => {
  const requests: SlackPostHttpRequest[] = [];
  const offline = new OfflineSlackHttp('success');
  const transport: SlackPostHttpPort = {
    mode: 'offline',
    request: async (request) => {
      requests.push(request);
      return await (override?.(request) ?? offline.request(request));
    },
  };
  return { requests, transport, adapter: new SlackPostMessageAdapter(transport, () => now) };
};
const isPost = (request: SlackPostHttpRequest): boolean => request.url === 'https://slack.com/api/chat.postMessage';

test('기본 비활성 포트는 합성 입력도 요청 0회로 거부한다', async () => {
  const adapter = new SlackPostMessageAdapter();
  const result = await adapter.verify(intent(), defaultSlackPostConfig);
  assert.equal(adapter.liveEnabled, false);
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.calls, { auth: 0, thread: 0, post: 0 });
  const disabled = new DisabledSlackPostHttp();
  assert.equal(disabled.mode, 'disabled');
  await assert.rejects(disabled.request({} as SlackPostHttpRequest), { message: 'SLACK_POST_DISABLED' });
});

test('고정 auth·스레드·단건 POST와 일반 텍스트 payload만 합성 HTTP로 전달한다', async () => {
  const { adapter, requests } = wrapOffline();
  const result = await adapter.verify(intent(), defaultSlackPostConfig);
  assert.equal(result.status, 'OFFLINE_CONFIRMED');
  assert.deepEqual(result.calls, { auth: 1, thread: 1, post: 1 });
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET', 'POST']);
  assert.equal(requests[0]?.url, 'https://slack.com/api/auth.test');
  const thread = new URL(requests[1]!.url);
  assert.equal(thread.origin, 'https://slack.com');
  assert.equal(thread.pathname, '/api/conversations.replies');
  assert.deepEqual([...thread.searchParams.keys()], ['channel', 'ts']);
  assert.equal(thread.searchParams.get('channel'), defaultSlackPostConfig.channelId);
  assert.equal(thread.searchParams.get('ts'), offlineThreadMessages[0]?.ts);
  for (const request of requests) {
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers['Authorization'], 'Bearer SYNTHETIC_OFFLINE_TOKEN');
    assert.equal(request.url.includes('TOKEN'), false);
  }
  assert.deepEqual(JSON.parse(requests[2]!.body!) as unknown, {
    channel: defaultSlackPostConfig.channelId, text: offlinePostBody, thread_ts: offlineThreadMessages[0]?.ts,
    reply_broadcast: false, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
  });
  assert.deepEqual(result.receipt, {
    channelId: defaultSlackPostConfig.channelId, messageTs: '1700000001.000001', threadTs: offlineThreadMessages[0]?.ts,
  });
  assert.equal(JSON.stringify(result).includes(offlinePostBody), false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_OFFLINE_TOKEN'), false);
});

test('workspace·bot·user identity 불일치와 읽기 실패는 POST를 호출하지 않는다', async () => {
  for (const identity of [
    { team_id: 'T_OTHER', bot_id: defaultSlackPostConfig.botId, user_id: defaultSlackPostConfig.botUserId },
    { team_id: defaultSlackPostConfig.workspaceId, bot_id: 'B_OTHER', user_id: defaultSlackPostConfig.botUserId },
    { team_id: defaultSlackPostConfig.workspaceId, bot_id: defaultSlackPostConfig.botId, user_id: 'U_OTHER' },
  ]) {
    const { adapter } = wrapOffline((request) => request.url.endsWith('/auth.test') ? Promise.resolve(jsonResponse({ ok: true, ...identity })) : undefined);
    const result = await adapter.verify(intent(), defaultSlackPostConfig);
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(result.calls, { auth: 1, thread: 0, post: 0 });
  }
  for (const fixture of ['source-changed', 'new-reply', 'incomplete'] as const) {
    const result = await new SlackPostMessageAdapter(new OfflineSlackHttp(fixture), () => now).verify(intent(), defaultSlackPostConfig);
    assert.equal(result.status, 'BLOCKED', fixture);
    assert.equal(result.calls.post, 0);
  }
  const failedRead = wrapOffline((request) => request.method === 'GET' ? Promise.reject(new Error('private-source-body')) : undefined);
  const result = await failedRead.adapter.verify(intent(), defaultSlackPostConfig);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.calls.post, 0);
  assert.equal(JSON.stringify(result).includes('private-source-body'), false);
});

test('HTTP·API·잘못된 영수증 결과를 보수적으로 분류하고 재시도하지 않는다', async () => {
  const fixtures: [SlackPostFixture, string][] = [
    ['denied', 'NOT_SENT'], ['rate-limited', 'NOT_SENT'], ['server-error', 'UNKNOWN'],
    ['malformed', 'UNKNOWN'], ['oversized', 'UNKNOWN'], ['receipt-mismatch', 'UNKNOWN'], ['redirect', 'UNKNOWN'],
  ];
  for (const [fixture, expected] of fixtures) {
    const result = await new SlackPostMessageAdapter(new OfflineSlackHttp(fixture), () => now).verify(intent(), defaultSlackPostConfig);
    assert.equal(result.status, expected, fixture);
    assert.equal(result.calls.post, 1, fixture);
    assert.equal(result.receipt, null);
  }
  for (const error of ['fatal_error', 'internal_error', 'unrecognized-secret-error']) {
    const { adapter } = wrapOffline((request) => isPost(request) ? Promise.resolve(jsonResponse({ ok: false, error })) : undefined);
    const result = await adapter.verify(intent(), defaultSlackPostConfig);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.calls.post, 1);
    assert.equal(JSON.stringify(result).includes(error), false);
  }
});

test('응답 유실·무응답·응답 스트림 정지는 모두 시간 제한 후 UNKNOWN이다', async () => {
  const timeout = await new SlackPostMessageAdapter(new OfflineSlackHttp('timeout'), () => now).verify(intent(), defaultSlackPostConfig);
  assert.equal(timeout.status, 'UNKNOWN');
  assert.equal(timeout.code, 'SLACK_POST_REQUEST_TIMEOUT');
  for (const response of [
    async (): Promise<Response> => { throw new Error('credential-and-private-body'); },
    async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>()),
  ]) {
    const { adapter } = wrapOffline((request) => isPost(request) ? response() : undefined);
    const result = await adapter.verify(intent(), defaultSlackPostConfig);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.calls.post, 1);
    assert.equal(JSON.stringify(result).includes('credential-and-private-body'), false);
  }
});

test('POST 전 취소·만료는 차단하고 POST 중 취소는 UNKNOWN이며 재전송하지 않는다', async () => {
  const controller = new AbortController();
  controller.abort();
  const { adapter, requests } = wrapOffline();
  const preAborted = await adapter.verify(intent(), defaultSlackPostConfig, controller.signal);
  assert.equal(preAborted.status, 'BLOCKED');
  assert.equal(requests.length, 0);
  let current = now;
  const offline = new OfflineSlackHttp('success');
  const expiresAfterRead: SlackPostHttpPort = {
    mode: 'offline',
    request: async (request) => {
      const response = await offline.request(request);
      if (request.method === 'GET') current = new Date(now.getTime() + 60_000);
      return response;
    },
  };
  const expired = await new SlackPostMessageAdapter(expiresAfterRead, () => current).verify(intent(), defaultSlackPostConfig);
  assert.equal(expired.status, 'BLOCKED');
  assert.equal(expired.calls.post, 0);
  const midAbort = new AbortController();
  let postSignal: AbortSignal | undefined;
  const pendingPost = wrapOffline((request) => {
    if (!isPost(request)) return undefined;
    postSignal = request.signal;
    return new Promise<Response>(() => {});
  });
  const pending = pendingPost.adapter.verify(intent(), defaultSlackPostConfig, midAbort.signal);
  while (postSignal === undefined) await nextTurn();
  midAbort.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, 'UNKNOWN');
  assert.equal(postSignal.aborted, true);
  assert.equal(cancelled.calls.post, 1);
});

test('기존 모의 승인·변조 intent·설정 변경은 HTTP 이전에 거부한다', async () => {
  const { adapter, requests } = wrapOffline();
  for (const value of [
    { policy: 'mock-reply-v1', mode: 'mock', usedAt: null },
    { ...intent(), channelId: 'C_OTHER' },
    { ...intent(), intentHash: 'private-input-body' },
    { ...intent(), body: 'private-input-body' },
  ]) {
    const result = await adapter.verify(value as OfflinePostIntent, defaultSlackPostConfig);
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(result.calls, { auth: 0, thread: 0, post: 0 });
    assert.equal(JSON.stringify(result).includes('private-input-body'), false);
  }
  const configChanged = await adapter.verify(intent(), { ...defaultSlackPostConfig, liveEnabled: true } as unknown as typeof defaultSlackPostConfig);
  assert.equal(configChanged.status, 'BLOCKED');
  assert.equal(requests.length, 0);
});

test('같은 operationId의 순차·동시 호출도 어댑터 수명 동안 POST는 한 번이다', async () => {
  const sameIntent = intent();
  const { adapter, requests } = wrapOffline();
  const results = await Promise.all([
    adapter.verify(sameIntent, defaultSlackPostConfig), adapter.verify(sameIntent, defaultSlackPostConfig),
  ]);
  assert.equal(results.filter((result) => result.status === 'OFFLINE_CONFIRMED').length, 1);
  assert.equal(results.filter((result) => result.status === 'BLOCKED').length, 1);
  assert.equal(requests.filter(isPost).length, 1);
  const repeated = await adapter.verify(sameIntent, defaultSlackPostConfig);
  assert.equal(repeated.status, 'BLOCKED');
  assert.deepEqual(repeated.calls, { auth: 0, thread: 0, post: 0 });
});

test('오프라인 포트도 임의 URL·토큰·메서드·추가 전송 필드를 거부한다', async () => {
  const { adapter, requests } = wrapOffline();
  await adapter.verify(intent(), defaultSlackPostConfig);
  const offline = new OfflineSlackHttp('success');
  const post = requests.find(isPost)!;
  const thread = requests.find((request) => request.method === 'GET')!;
  const signal = new AbortController().signal;
  for (const invalid of [
    { ...post, url: 'https://synthetic.invalid/chat.postMessage' },
    { ...post, url: `${post.url}?token=synthetic` },
    { ...thread, url: `${thread.url}&cursor=arbitrary` },
    { ...post, method: 'GET' as const },
    { ...post, redirect: 'follow' as 'error' },
    { ...post, headers: { ...post.headers, Authorization: 'Bearer real-token-placeholder' } },
    { ...post, body: JSON.stringify({ ...(JSON.parse(post.body!) as Record<string, unknown>), blocks: [] }) },
  ]) await assert.rejects(offline.request({ ...invalid, signal }), { message: 'SLACK_POST_INVALID_HTTP_REQUEST' });
});

test('auth·스레드 응답의 timeout·크기 초과·redirect도 POST 없이 차단한다', async () => {
  for (const target of ['auth', 'thread'] as const) {
    for (const response of [
      async (): Promise<Response> => new Promise<Response>(() => {}),
      async (): Promise<Response> => new Response('', { headers: { 'Content-Length': '16385' } }),
      async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8192));
          controller.enqueue(new Uint8Array(8193));
          controller.close();
        },
      })),
      async (): Promise<Response> => new Response(null, { status: 307, headers: { Location: 'https://synthetic.invalid/' } }),
    ]) {
      const { adapter } = wrapOffline((request) => {
        const matches = target === 'auth' ? request.url.endsWith('/auth.test') : request.method === 'GET';
        return matches ? response() : undefined;
      });
      const result = await adapter.verify(intent(), defaultSlackPostConfig);
      assert.equal(result.status, 'BLOCKED', target);
      assert.equal(result.calls.post, 0);
      assert.equal(result.calls.auth, 1);
      assert.equal(result.calls.thread, target === 'auth' ? 0 : 1);
    }
  }
});

test('오류에 성공 증거가 섞이거나 영수증의 필드 하나만 달라도 UNKNOWN이다', async () => {
  const baseline = {
    ok: true, channel: defaultSlackPostConfig.channelId, ts: '1700000001.000001',
    message: {
      ts: '1700000001.000001', thread_ts: offlineThreadMessages[0]!.ts,
      user: defaultSlackPostConfig.botUserId, bot_id: defaultSlackPostConfig.botId, text: offlinePostBody,
    },
  };
  for (const payload of [
    { ok: false, error: 'missing_scope', ts: '1700000001.000001' },
    { ...baseline, ts: 'invalid-ts' },
    { ...baseline, ts: offlineThreadMessages[1]!.ts, message: { ...baseline.message, ts: offlineThreadMessages[1]!.ts } },
    { ...baseline, message: { ...baseline.message, ts: '1700000001.000002' } },
    { ...baseline, message: { ...baseline.message, thread_ts: '1700000001.000003' } },
    { ...baseline, message: { ...baseline.message, user: 'U_OTHER' } },
    { ...baseline, message: { ...baseline.message, bot_id: 'B_OTHER' } },
    { ...baseline, message: { ...baseline.message, text: 'private-body-echo' } },
  ]) {
    const { adapter } = wrapOffline((request) => isPost(request) ? Promise.resolve(jsonResponse(payload)) : undefined);
    const result = await adapter.verify(intent(), defaultSlackPostConfig);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.calls.post, 1);
    assert.equal(result.receipt, null);
    assert.equal(JSON.stringify(result).includes('private-body-echo'), false);
  }
});
