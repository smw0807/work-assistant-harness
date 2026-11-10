import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { SlackReadClient } from '../src/adapters/slack-read-client.js';
import { SLACK_SOCKET_HOSTS, SlackSocketTransport, validateSlackSocketUrl } from '../src/adapters/slack-socket-transport.js';
import { HarnessError } from '../src/domain/errors.js';

const socketUrl = 'wss://wss.slack.com/link/?ticket=synthetic-ticket';
const credentials = { appToken: 'synthetic-app-token', webToken: 'synthetic-web-token' };
const limits = { maxMessages: 10, maxPages: 3, maxBytes: 4096 };
const hasCode = (code: string) => (error: unknown): boolean => error instanceof HarnessError && error.code === code;
const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value));
const threadMessage = (ts = '1700000000.000001') => ({ ts, user: 'U_REQUESTER', text: '합성 스레드 문맥' });
const envelope = (id = 'envelope-1') => ({ type: 'events_api', envelope_id: id, payload: { event_id: 'Ev_synthetic', event: { text: '합성 이벤트' } } });

class FakeSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('synthetic-ticket');
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }));
  }

  disconnect(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

test('Slack API는 고정 읽기 메서드와 Authorization 헤더만 사용하고 redirect를 거부한다', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = new SlackReadClient(credentials, {
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.length === 1 ? jsonResponse({ ok: true, url: socketUrl }) : jsonResponse({ ok: true, messages: [{ ...threadMessage(), private_metadata: 'excluded' }] });
    },
  });
  assert.equal(await client.openSocket(), socketUrl);
  assert.deepEqual(await client.readThread('C_ALLOWED', '1700000000.000001', limits), { messages: [threadMessage()], complete: true, reason: null });
  assert.equal(calls[0]?.url, 'https://slack.com/api/apps.connections.open');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), `Bearer ${credentials.appToken}`);
  const threadCall = calls[1];
  assert.ok(threadCall);
  const threadUrl = new URL(threadCall.url);
  assert.equal(threadUrl.origin, 'https://slack.com');
  assert.equal(threadUrl.pathname, '/api/conversations.replies');
  assert.equal(threadUrl.searchParams.get('channel'), 'C_ALLOWED');
  assert.equal(threadUrl.searchParams.get('ts'), '1700000000.000001');
  assert.equal(threadUrl.searchParams.has('token'), false);
  assert.equal(threadCall.init?.method, 'GET');
  assert.equal(new Headers(threadCall.init?.headers).get('authorization'), `Bearer ${credentials.webToken}`);
  for (const call of calls) assert.equal(call.init?.redirect, 'error');
  assert.equal('postMessage' in client, false);
});

test('auth.test의 읽기 토큰 workspace를 확인하고 다른 workspace와 잘못된 응답을 정적 코드로 거부한다', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = new SlackReadClient(credentials, {
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ ok: true, team_id: 'W_LOCAL', user_id: 'U_UNUSED', url: 'https://ignored.invalid/' });
    },
  });
  assert.equal(await client.verifyWorkspace('W_LOCAL'), undefined);
  assert.equal(calls[0]?.url, 'https://slack.com/api/auth.test');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.redirect, 'error');
  assert.equal(calls[0]?.init?.body, '');
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), `Bearer ${credentials.webToken}`);
  await assert.rejects(client.verifyWorkspace('W_OTHER'), hasCode('SLACK_WORKSPACE_MISMATCH'));
  for (const response of [
    { ok: true }, { ok: true, team_id: 42 }, { ok: true, team_id: `https://ignored.invalid/?token=${credentials.webToken}` },
    { ok: false, error: credentials.webToken },
  ]) {
    const malformed = new SlackReadClient(credentials, { fetch: async () => jsonResponse(response) });
    await assert.rejects(malformed.verifyWorkspace('W_LOCAL'), (error: unknown) => {
      assert.ok(error instanceof HarnessError);
      assert.equal(error.code, response.ok ? 'SLACK_INVALID_RESPONSE' : 'SLACK_API_REJECTED');
      assert.equal(error.message.includes(credentials.webToken), false);
      assert.equal(error.message.includes(credentials.appToken), false);
      assert.equal(error.message.includes('ignored.invalid'), false);
      return true;
    });
  }
  await assert.rejects(client.verifyWorkspace('../W_LOCAL'), hasCode('SLACK_INVALID_WORKSPACE'));
  assert.equal(calls.length, 2);
});

test('workspace 검증도 abort로 취소하며 후속 API 요청을 하지 않는다', async () => {
  const controller = new AbortController();
  let requests = 0;
  let requestSignal: AbortSignal | undefined;
  const client = new SlackReadClient(credentials, {
    fetch: async (_input, init) => {
      requests += 1;
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    },
  });
  const verifying = client.verifyWorkspace('W_LOCAL', controller.signal);
  const rejected = assert.rejects(verifying, hasCode('SLACK_REQUEST_CANCELLED'));
  controller.abort();
  await rejected;
  assert.equal(requestSignal?.aborted, true);
  await assert.rejects(client.verifyWorkspace('W_LOCAL', controller.signal), hasCode('SLACK_REQUEST_CANCELLED'));
  assert.equal(requests, 1);
});

test('429는 Retry-After만큼 대기하며 제한된 횟수만 재시도한다', async () => {
  let requests = 0;
  const waits: number[] = [];
  const client = new SlackReadClient({ ...credentials, maxRetries: 2 }, {
    fetch: async () => {
      requests += 1;
      return requests < 3 ? new Response('ignored', { status: 429, headers: { 'Retry-After': '2' } }) : jsonResponse({ ok: true, url: socketUrl });
    },
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(await client.openSocket(), socketUrl);
  assert.equal(requests, 3);
  assert.deepEqual(waits, [2000, 2000]);
  for (const retryAfter of ['61', 'invalid', '-1', '1.5', '999999999999999999999']) {
    const blocked = new SlackReadClient(credentials, {
      fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': retryAfter } }),
      sleep: async () => { assert.fail('잘못된 대기 시간을 사용하면 안 됩니다.'); },
    });
    await assert.rejects(blocked.openSocket(), hasCode('SLACK_RATE_LIMITED'));
  }
  const exhausted = new SlackReadClient({ ...credentials, maxRetries: 0 }, { fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': '1' } }) });
  await assert.rejects(exhausted.openSocket(), hasCode('SLACK_RATE_LIMITED'));
});

test('Slack 오류·잘못된 JSON·과도한 응답을 정적 코드로 차단한다', async () => {
  const cases: [() => Promise<Response>, string][] = [
    [async () => { throw new Error(`https://unsafe.invalid/?token=${credentials.appToken}`); }, 'SLACK_REQUEST_FAILED'],
    [async () => new Response(credentials.appToken, { status: 401 }), 'SLACK_HTTP_FAILED'],
    [async () => jsonResponse({ ok: false, error: credentials.appToken }), 'SLACK_API_REJECTED'],
    [async () => new Response(`invalid-json-${credentials.appToken}`), 'SLACK_INVALID_RESPONSE'],
    [async () => jsonResponse([]), 'SLACK_INVALID_RESPONSE'],
    [async () => new Response('x'.repeat(262_145)), 'SLACK_RESPONSE_TOO_LARGE'],
    [async () => new Response('', { headers: { 'Content-Length': '262145' } }), 'SLACK_RESPONSE_TOO_LARGE'],
    [async () => jsonResponse({ ok: true, url: `wss://unsafe.invalid/?token=${credentials.appToken}` }), 'SLACK_INVALID_SOCKET_URL'],
  ];
  for (const [fetch, code] of cases) {
    const client = new SlackReadClient(credentials, { fetch });
    await assert.rejects(client.openSocket(), (error: unknown) => {
      assert.ok(error instanceof HarnessError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(credentials.appToken), false);
      return true;
    });
  }
});

test('HTTP 요청과 응답 스트림 읽기 모두 시간 상한을 갖는다', async () => {
  const stalledFetch = new SlackReadClient({ ...credentials, requestTimeoutMs: 5 }, { fetch: async () => new Promise<Response>(() => {}) });
  await assert.rejects(stalledFetch.openSocket(), hasCode('SLACK_REQUEST_TIMEOUT'));
  const stalledBody = new SlackReadClient({ ...credentials, requestTimeoutMs: 5 }, { fetch: async () => new Response(new ReadableStream<Uint8Array>()) });
  await assert.rejects(stalledBody.openSocket(), hasCode('SLACK_REQUEST_TIMEOUT'));
});

test('연결 URL 요청과 429 대기를 abort하면 토큰을 노출하지 않고 즉시 취소한다', async () => {
  const requestAbort = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const client = new SlackReadClient(credentials, {
    fetch: async (_input, init) => { requestSignal = init?.signal ?? undefined; return new Promise<Response>(() => {}); },
  });
  const request = client.openSocket(requestAbort.signal);
  const requestRejected = assert.rejects(request, hasCode('SLACK_REQUEST_CANCELLED'));
  requestAbort.abort();
  await requestRejected;
  assert.equal(requestSignal?.aborted, true);
  const retryAbort = new AbortController();
  const retrying = new SlackReadClient(credentials, { fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }) });
  const retry = retrying.openSocket(retryAbort.signal);
  const retryRejected = assert.rejects(retry, hasCode('SLACK_REQUEST_CANCELLED'));
  await nextTurn();
  retryAbort.abort();
  await retryRejected;
});

test('스레드 pagination을 수집하며 페이지·메시지·바이트 상한과 조회 불완전을 표시한다', async () => {
  const urls: URL[] = [];
  const client = new SlackReadClient(credentials, {
    fetch: async (url) => {
      urls.push(new URL(String(url)));
      return urls.length === 1
        ? jsonResponse({ ok: true, messages: [threadMessage()], response_metadata: { next_cursor: 'next-page' } })
        : jsonResponse({ ok: true, messages: [threadMessage('1700000000.000002')], response_metadata: { next_cursor: '' } });
    },
  });
  const result = await client.readThread('C_ALLOWED', '1700000000.000001', limits);
  assert.equal(result.messages.length, 2);
  assert.equal(result.complete, true);
  assert.equal(urls[1]?.searchParams.get('cursor'), 'next-page');
  const cases: [unknown, typeof limits, string][] = [
    [{ ok: true, messages: [threadMessage()], response_metadata: { next_cursor: 'next' } }, { ...limits, maxPages: 1 }, 'SLACK_THREAD_PAGE_LIMIT'],
    [{ ok: true, messages: [threadMessage(), threadMessage('1700000000.000002')] }, { ...limits, maxMessages: 1 }, 'SLACK_THREAD_MESSAGE_LIMIT'],
    [{ ok: true, messages: [threadMessage()] }, { ...limits, maxBytes: 1 }, 'SLACK_THREAD_BYTE_LIMIT'],
    [{ ok: true, messages: [threadMessage()], has_more: true }, limits, 'SLACK_THREAD_MISSING_CURSOR'],
    [{ ok: true, messages: [threadMessage()], response_metadata: { next_cursor: 'repeated' } }, limits, 'SLACK_THREAD_REPEATED_CURSOR'],
    [{ ok: true, messages: [{ ts: '1700000000.000001', bot_id: 'B_SYNTHETIC', text: 'bot' }] }, limits, 'SLACK_THREAD_UNSUPPORTED_MESSAGE'],
    [{ ok: true, messages: 'invalid' }, limits, 'SLACK_INVALID_RESPONSE'],
  ];
  for (const [body, requestedLimits, reason] of cases) {
    const bounded = new SlackReadClient(credentials, { fetch: async () => jsonResponse(body) });
    const partial = await bounded.readThread('C_ALLOWED', '1700000000.000001', requestedLimits);
    assert.equal(partial.complete, false);
    assert.equal(partial.reason, reason);
  }
  const unavailable = new SlackReadClient(credentials, { fetch: async () => { throw new Error('synthetic-secret'); } });
  assert.deepEqual(await unavailable.readThread('C_ALLOWED', '1700000000.000001', limits), { messages: [], complete: false, reason: 'SLACK_REQUEST_FAILED' });
});

test('스레드 429 대기 중 abort하면 추가 API 요청 없이 불완전 조회로 끝낸다', async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = new SlackReadClient(credentials, {
    fetch: async () => {
      requests += 1;
      return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    },
  });
  const pending = client.readThread('C_ALLOWED', '1700000000.000001', limits, controller.signal);
  await nextTurn();
  controller.abort();
  assert.deepEqual(await pending, { messages: [], complete: false, reason: 'SLACK_REQUEST_CANCELLED' });
  assert.equal(requests, 1);
  const preAborted = await client.readThread('C_ALLOWED', '1700000000.000001', undefined, controller.signal);
  assert.equal(preAborted.reason, 'SLACK_REQUEST_CANCELLED');
  assert.equal(requests, 1);
});

test('여러 페이지를 읽던 중 abort하면 받은 문맥을 불완전으로 남기고 다음 페이지를 요청하지 않는다', async () => {
  const controller = new AbortController();
  let requests = 0;
  let secondRequestSignal: AbortSignal | undefined;
  const client = new SlackReadClient(credentials, {
    fetch: async (_input, init) => {
      requests += 1;
      if (requests === 1) return jsonResponse({ ok: true, messages: [threadMessage()], response_metadata: { next_cursor: 'next-page' } });
      secondRequestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    },
  });
  const pending = client.readThread('C_ALLOWED', '1700000000.000001', limits, controller.signal);
  await nextTurn();
  assert.equal(requests, 2);
  controller.abort();
  assert.deepEqual(await pending, { messages: [threadMessage()], complete: false, reason: 'SLACK_REQUEST_CANCELLED' });
  assert.equal(requests, 2);
  assert.equal(secondRequestSignal?.aborted, true);
});

test('자격증명·스레드 식별자·상한 설정이 잘못되면 네트워크 전에 거부한다', async () => {
  const client = new SlackReadClient(credentials, { fetch: async () => { assert.fail('호출하면 안 됩니다.'); } });
  assert.throws(() => new SlackReadClient({ ...credentials, appToken: '' }), hasCode('SLACK_INVALID_CREDENTIALS'));
  assert.throws(() => new SlackReadClient({ ...credentials, maxRetries: 6 }), hasCode('SLACK_INVALID_LIMIT'));
  await assert.rejects(client.readThread('../C_ALLOWED', '1700000000.000001'), hasCode('SLACK_INVALID_THREAD'));
  await assert.rejects(client.readThread('C_ALLOWED', 'invalid'), hasCode('SLACK_INVALID_THREAD'));
  await assert.rejects(client.readThread('C_ALLOWED', '1700000000.000001', { ...limits, maxMessages: 201 }), hasCode('SLACK_INVALID_LIMIT'));
});

test('WebSocket 목적지를 정확한 Slack 호스트와 기본 WSS 연결로 제한한다', () => {
  for (const host of SLACK_SOCKET_HOSTS) assert.equal(validateSlackSocketUrl(`wss://${host}/link/?ticket=synthetic`), `wss://${host}/link/?ticket=synthetic`);
  for (const url of [
    'https://wss.slack.com/link/', 'ws://wss.slack.com/link/', 'wss://wss.slack.com.evil.invalid/link/',
    'wss://evil.invalid/link/', 'wss://user@wss.slack.com/link/', 'wss://@wss.slack.com/link/',
    'wss://wss.slack.com:443/link/', 'wss://wss.slack.com:8443/link/', 'wss://wss.slack.com/link/#fragment',
    'wss://wss.slack.com\\@evil.invalid/link/', ' wss://wss.slack.com/link/', 'not-a-url',
  ]) assert.throws(() => validateSlackSocketUrl(url), hasCode('SLACK_INVALID_SOCKET_URL'));
});

test('Socket Mode ACK는 intake 호출 이후 한 번만 보내며 응답 payload는 보내지 않는다', async () => {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const connections: string[] = [];
  let received: unknown;
  let acknowledge: (() => Promise<void>) | undefined;
  const transport = new SlackSocketTransport({ openSocket: async () => socketUrl }, { createSocket: () => socket });
  const running = transport.run(async (input, ack) => { received = input; acknowledge = ack; }, controller.signal, (state) => { connections.push(state); });
  await nextTurn();
  socket.open();
  socket.receive({ type: 'hello', debug_info: { host: 'do-not-log' } });
  socket.receive(envelope());
  await nextTurn();
  assert.deepEqual(received, envelope());
  assert.equal(socket.sent.length, 0);
  assert.ok(acknowledge);
  await acknowledge();
  await acknowledge();
  assert.deepEqual(socket.sent, [JSON.stringify({ envelope_id: 'envelope-1' })]);
  controller.abort();
  await running;
  assert.deepEqual(connections, ['connected']);
  assert.equal(socket.closeCalls, 1);
});

test('저장 실패는 ACK 없이 연결 공백으로 기록하고 재시도 상한에서 멈춘다', async () => {
  const socket = new FakeSocket();
  const connections: string[] = [];
  const transport = new SlackSocketTransport({ openSocket: async () => socketUrl }, { createSocket: () => socket, maxReconnects: 0 });
  const running = transport.run(async () => { throw new Error('synthetic-sensitive-body'); }, new AbortController().signal, (state, reason) => { connections.push(`${state}:${reason}`); });
  const rejected = assert.rejects(running, hasCode('SLACK_RECONNECT_LIMIT'));
  await nextTurn();
  socket.open();
  socket.receive(envelope());
  await rejected;
  assert.equal(socket.sent.length, 0);
  assert.deepEqual(connections, ['connected:SLACK_SOCKET_CONNECTED', 'gap:SLACK_SOCKET_HANDLER_FAILED']);
});

test('재연결은 새 URL을 얻고 공백과 제한된 backoff를 기록한다', async () => {
  const sockets: FakeSocket[] = [];
  const waits: number[] = [];
  const connections: string[] = [];
  let opens = 0;
  const controller = new AbortController();
  const transport = new SlackSocketTransport({ openSocket: async () => { opens += 1; return socketUrl; } }, {
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  const running = transport.run(async (_input, ack) => { await ack(); }, controller.signal, (state, reason) => { connections.push(`${state}:${reason}`); });
  await nextTurn();
  sockets[0]?.open();
  sockets[0]?.receive({ type: 'disconnect', reason: 'synthetic-sensitive-body' });
  await nextTurn();
  sockets[1]?.open();
  sockets[1]?.receive(envelope());
  await nextTurn();
  controller.abort();
  await running;
  assert.equal(opens, 2);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(connections, ['connected:SLACK_SOCKET_CONNECTED', 'gap:SLACK_SOCKET_REFRESH', 'connected:SLACK_SOCKET_CONNECTED']);
  assert.equal(sockets[1]?.sent.length, 1);
});

test('잘못된 socket 입력과 큐 포화는 ACK 없이 연결을 닫는다', async () => {
  for (const [input, reason] of [
    ['invalid json', 'SLACK_SOCKET_INVALID_JSON'],
    ['x'.repeat(131_073), 'SLACK_SOCKET_MESSAGE_LIMIT'],
    [[], 'SLACK_SOCKET_INVALID_MESSAGE'],
    [{ type: 'events_api', envelope_id: '../invalid' }, 'SLACK_SOCKET_INVALID_ENVELOPE'],
  ] as const) {
    const socket = new FakeSocket();
    const gaps: string[] = [];
    const transport = new SlackSocketTransport({ openSocket: async () => socketUrl }, { createSocket: () => socket, maxReconnects: 0 });
    const running = transport.run(async () => { assert.fail('잘못된 입력을 전달하면 안 됩니다.'); }, new AbortController().signal, (state, code) => { if (state === 'gap') gaps.push(code); });
    const rejected = assert.rejects(running, hasCode('SLACK_RECONNECT_LIMIT'));
    await nextTurn();
    socket.open();
    socket.receive(input);
    await rejected;
    assert.deepEqual(gaps, [reason]);
    assert.equal(socket.sent.length, 0);
  }
  const socket = new FakeSocket();
  const gaps: string[] = [];
  const transport = new SlackSocketTransport({ openSocket: async () => socketUrl }, { createSocket: () => socket, maxReconnects: 0 });
  const running = transport.run(async () => new Promise<void>(() => {}), new AbortController().signal, (state, reason) => { if (state === 'gap') gaps.push(reason); });
  const rejected = assert.rejects(running, hasCode('SLACK_RECONNECT_LIMIT'));
  await nextTurn();
  socket.open();
  for (let index = 0; index <= 100; index += 1) socket.receive(envelope(`envelope-${index}`));
  await rejected;
  assert.deepEqual(gaps, ['SLACK_SOCKET_QUEUE_LIMIT']);
  assert.equal(socket.sent.length, 0);
});

test('연결 시간 초과·abort와 미허용 URL을 처리하며 socket 생성 전 경계를 확인한다', async () => {
  const gaps: string[] = [];
  const timeout = new SlackSocketTransport({ openSocket: async () => socketUrl }, { createSocket: () => new FakeSocket(), maxReconnects: 0, connectTimeoutMs: 5 });
  await assert.rejects(timeout.run(async () => {}, new AbortController().signal, (state, reason) => { if (state === 'gap') gaps.push(reason); }), hasCode('SLACK_RECONNECT_LIMIT'));
  assert.deepEqual(gaps, ['SLACK_SOCKET_CONNECT_TIMEOUT']);
  const blocked = new SlackSocketTransport({ openSocket: async () => 'wss://evil.invalid/?secret=synthetic' }, { createSocket: () => { assert.fail('socket을 만들면 안 됩니다.'); }, maxReconnects: 0 });
  await assert.rejects(blocked.run(async () => {}, new AbortController().signal, () => {}), hasCode('SLACK_RECONNECT_LIMIT'));
  const controller = new AbortController();
  controller.abort();
  await new SlackSocketTransport({ openSocket: async () => { assert.fail('abort 이후 호출하면 안 됩니다.'); } }).run(async () => {}, controller.signal, () => {});
  const pendingAbort = new AbortController();
  const pending = new SlackSocketTransport({ openSocket: async () => new Promise<string>(() => {}) }).run(async () => {}, pendingAbort.signal, () => { assert.fail('종료 중 공백을 추가하면 안 됩니다.'); });
  pendingAbort.abort();
  await pending;
});
