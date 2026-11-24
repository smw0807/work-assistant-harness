import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackListExportClient } from '../src/adapters/slack-list-export.js';
import { HarnessError, SlackListApiError } from '../src/domain/errors.js';

const workspaceId = 'T_LOCAL';
const listId = 'F_LIST';
const token = 'synthetic-only-token';
const url = 'https://files.slack.com/files-pri/T_LOCAL-F_LIST/json/list?origin_team=T_LOCAL&include_threads=true';
const signal = (): AbortSignal => new AbortController().signal;
const start = (): Response => Response.json({ ok: true, job_id: 'Le_SYNTHETIC' });
const completed = (downloadUrl = url): Response => Response.json({ ok: true, status: 'COMPLETED', download_url: downloadUrl });
const hasCode = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof HarnessError);
  assert.equal(error.code, `SLACK_LIST_${code}`);
  assert.equal(error.message, error.code);
  return true;
};

const mockExport = (...responses: Response[]) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const waits: number[] = [];
  const client = new SlackListExportClient(token, {
    fetch: async (target, init) => {
      calls.push({ url: String(target), init });
      const next = responses.shift();
      assert.ok(next, '예상하지 않은 요청');
      return next;
    },
    sleep: async (ms) => { waits.push(ms); },
  });
  return { client, calls, waits };
};

test('리스트 내보내기는 스레드 포함 옵션을 두 API에 일치시키고 지정한 파일만 읽는다', async () => {
  const raw = { rows: [{ synthetic: true }] };
  const mock = mockExport(start(), Response.json({ ok: true, status: 'PROCESSING' }), completed(), Response.json(raw));
  assert.deepEqual(await mock.client.read(workspaceId, listId, signal()), raw);
  const options = { list_id: listId, format: 'json', include_threads: true, include_attachments: false, include_archived: false };
  assert.deepEqual(mock.calls.map(call => [call.url, call.init?.method]), [
    ['https://slack.com/api/slackLists.download.start', 'POST'],
    ['https://slack.com/api/slackLists.download.get', 'POST'],
    ['https://slack.com/api/slackLists.download.get', 'POST'],
    [url, 'GET'],
  ]);
  for (const [i, call] of mock.calls.entries()) {
    assert.equal(call.init?.redirect, 'manual');
    assert.equal(call.init?.credentials, 'omit');
    assert.equal(new Headers(call.init?.headers).get('authorization'), `Bearer ${token}`);
    if (i < 3) {
      assert.deepEqual(JSON.parse(String(call.init?.body)), i === 0 ? options : { ...options, job_id: 'Le_SYNTHETIC' });
    } else {
      assert.equal(call.init?.body, null);
    }
  }
  assert.deepEqual(mock.waits, [2000]);
});

test('다운로드의 주소·경로·workspace·list 위조나 리디렉션에 자격증명을 전달하지 않는다', async () => {
  const unsafe = [
    url.replace('files.slack.com', 'files.slack.com.evil.invalid'), url.replace('files.slack.com', 'files.com'),
    url.replace('files.slack.com', 'files.slack.com:443'), url.replace('files.slack.com', 'user@files.slack.com'),
    url.replace('files.slack.com', 'files.slack.com\\@evil.invalid'), url.replace('https:', 'http:'), `${url}#fragment`,
    url.replace('F_LIST', 'F_OTHER'), url.replace('T_LOCAL-F_LIST', 'T_OTHER-F_LIST'),
    url.replace('origin_team=T_LOCAL', 'origin_team=T_OTHER'), url.replace('json/list', '../list'),
    url.replace('json/list', '%2e%2e/list'), 'https://slack.com/api/chat.postMessage',
  ];
  for (const target of unsafe) {
    const mock = mockExport(start(), completed(target));
    await assert.rejects(mock.client.read(workspaceId, listId, signal()), hasCode('INVALID_DOWNLOAD_URL'));
    assert.equal(mock.calls.length, 2);
  }
  const redirected = mockExport(start(), completed(), Response.redirect('https://outside.invalid/'));
  await assert.rejects(redirected.client.read(workspaceId, listId, signal()), error => {
    assert.ok(error instanceof SlackListApiError);
    assert.equal(error.method, 'file.download');
    return hasCode('REDIRECT_DENIED')(error);
  });
  assert.equal(redirected.calls.length, 3);
});

test('문서의 팀 접두사 생략 경로는 명시된 origin_team이 일치할 때 허용한다', async () => {
  const path = 'https://files.slack.com/files-pri/12345-FLIST/json/list';
  for (const suffix of ['', '?origin_team=TOTHER']) {
    const mock = mockExport(start(), completed(path + suffix));
    await assert.rejects(mock.client.read('T12345', 'FLIST', signal()), hasCode('INVALID_DOWNLOAD_URL'));
    assert.equal(mock.calls.length, 2);
  }
  const mock = mockExport(start(), completed(path + '?origin_team=T12345'), Response.json({ items: [] }));
  assert.deepEqual(await mock.client.read('T12345', 'FLIST', signal()), { items: [] });
});

test('리스트 조회를 거부한 Slack API 메서드와 사유를 함께 전달한다', async () => {
  for (const method of ['slackLists.download.start', 'slackLists.download.get'] as const) {
    const rejection = Response.json({ ok: false, error: 'list_not_found' });
    const mock = method === 'slackLists.download.start' ? mockExport(rejection) : mockExport(start(), rejection);
    await assert.rejects(mock.client.read(workspaceId, listId, signal()), (error: unknown) => {
      assert.ok(error instanceof SlackListApiError);
      assert.equal(error.method, method);
      return hasCode('API_LIST_NOT_FOUND')(error);
    });
  }
});

test('전송·본문 읽기·HTTP 실패를 호출 단계와 고정 사유로만 기록한다', async () => {
  const networkError = (code: string) => new TypeError(token, { cause: Object.assign(new Error(url), { code }) });
  const readFailure = new Response(new ReadableStream({ start(controller) { controller.error(networkError('UND_ERR_SOCKET')); } }));
  for (const [prefix, failure, method, code] of [
    [[], networkError('ENOTFOUND'), 'slackLists.download.start', 'DNS_FAILED'],
    [[start()], networkError('CERT_HAS_EXPIRED'), 'slackLists.download.get', 'TLS_FAILED'],
    [[start(), completed()], readFailure, 'file.download', 'CONNECTION_FAILED'],
    [[start(), completed()], networkError('UND_ERR_CONNECT_TIMEOUT'), 'file.download', 'CONNECTION_TIMEOUT'],
    [[start(), completed()], networkError(token), 'file.download', 'REQUEST_FAILED'],
    [[start()], Response.redirect(url), 'slackLists.download.get', 'REDIRECT_DENIED'],
    [[start(), completed()], new Response(token, { status: 401 }), 'file.download', 'HTTP_UNAUTHORIZED'],
    [[start(), completed()], new Response(token, { status: 403 }), 'file.download', 'HTTP_FORBIDDEN'],
  ] as const) {
    const sequence = [...prefix, failure];
    const client = new SlackListExportClient(token, { fetch: async () => {
      const step = sequence.shift();
      if (!(step instanceof Response)) throw step;
      return step;
    } });
    await assert.rejects(client.read(workspaceId, listId, signal()), error => {
      assert.ok(error instanceof SlackListApiError);
      assert.equal(error.method, method);
      assert.equal(error.cause, undefined);
      return hasCode(code)(error);
    });
    assert.equal(sequence.length, 0);
  }
});

test('리스트 API의 허용된 거부 사유만 기록하고 네트워크와 응답의 원문을 노출하지 않는다', async () => {
  for (const [response, code] of [
    [Response.json({ ok: false, error: 'missing_scope' }), 'API_MISSING_SCOPE'],
    [Response.json({ ok: false, error: 'access_denied' }), 'API_ACCESS_DENIED'],
    [Response.json({ ok: false, error: 'permission_denied' }), 'API_PERMISSION_DENIED'],
    [Response.json({ ok: false, error: token }), 'API_REJECTED'],
    [new Response(token), 'INVALID_RESPONSE'],
    [Response.json({ ok: true, job_id: 'private/job' }), 'INVALID_RESPONSE'],
  ] as const) {
    const mock = mockExport(response);
    await assert.rejects(mock.client.read(workspaceId, listId, signal()), hasCode(code));
    assert.equal(mock.calls.length, 1);
  }
  for (const injected of [new HarnessError(token), new SlackListApiError(token, 'slackLists.download.start')]) {
    const failing = new SlackListExportClient(token, { fetch: async () => { throw injected; } });
    await assert.rejects(failing.read(workspaceId, listId, signal()), hasCode('REQUEST_FAILED'));
  }
  const invalid = mockExport();
  await assert.rejects(invalid.client.read('T_LOCAL/another', listId, signal()), hasCode('INVALID_TARGET'));
  await assert.rejects(invalid.client.read(workspaceId, 'C_UNRELATED', signal()), hasCode('INVALID_TARGET'));
  assert.equal(invalid.calls.length, 0);
});

test('동시에 내보내기를 시작하지 않으며 요청 중 취소·시간 초과 뒤 후속 요청을 억제한다', async () => {
  let release: (response: Response) => void = () => {};
  let calls = 0;
  let httpSignal: AbortSignal | null | undefined;
  const client = new SlackListExportClient(token, {
    fetch: (_target, init) => {
      httpSignal = init?.signal;
      calls++;
      return new Promise<Response>((resolve) => { release = resolve; });
    },
    timeoutMs: 20,
  });
  const abort = new AbortController();
  const pending = client.read(workspaceId, listId, abort.signal);
  await assert.rejects(client.read(workspaceId, listId, signal()), hasCode('EXPORT_IN_PROGRESS'));
  abort.abort();
  await assert.rejects(pending, hasCode('CANCELLED'));
  assert.equal(httpSignal?.aborted, true);
  release(start());
  await assert.rejects(client.read(workspaceId, listId, abort.signal), hasCode('CANCELLED'));
  await assert.rejects(client.read(workspaceId, listId, signal()), hasCode('TIMEOUT'));
  assert.equal(httpSignal?.aborted, true);
  assert.equal(calls, 2);
});

test('응답 본문 크기는 선언값과 실제 디코딩되는 바이트 모두에 적용한다', async () => {
  const declared = mockExport(start(), completed(), new Response('{}', { headers: { 'content-length': '100000000' } }));
  await assert.rejects(declared.client.read(workspaceId, listId, signal()), hasCode('RESPONSE_TOO_LARGE'));
  let cancelled = false;
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }));
  const streamed = mockExport(start(), completed(), oversized);
  await assert.rejects(streamed.client.read(workspaceId, listId, signal()), hasCode('RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
  const invalid = mockExport(start(), completed(), new Response(new Uint8Array([34, 128, 34])));
  await assert.rejects(invalid.client.read(workspaceId, listId, signal()), hasCode('INVALID_RESPONSE'));
});

test('내보내기 본문이 멈춰 있어도 중단 시 reader를 취소하고 결과를 반환하지 않는다', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const stalled = new Response(new ReadableStream({
    pull() { setImmediate(() => abort.abort()); },
    cancel() { cancelled = true; },
  }));
  const mock = mockExport(start(), completed(), stalled);
  await assert.rejects(mock.client.read(workspaceId, listId, abort.signal), hasCode('CANCELLED'));
  assert.equal(mock.calls.length, 3);
  assert.equal(cancelled, true);
});

test('429 Retry-After와 작업 상태 폴링을 제한하고 결과가 없으면 다운로드하지 않는다', async () => {
  const throttled = (seconds: string): Response => new Response('', { status: 429, headers: { 'retry-after': seconds } });
  const limited = mockExport(throttled('1'), start(), completed(), throttled('2'), Response.json([]));
  assert.deepEqual(await limited.client.read(workspaceId, listId, signal()), []);
  assert.deepEqual(limited.waits, [1000, 2000]);
  for (const retry of ['1000', 'invalid', '-1']) {
    const refused = mockExport(throttled(retry));
    await assert.rejects(refused.client.read(workspaceId, listId, signal()), hasCode('RATE_LIMITED'));
    assert.deepEqual(refused.waits, []);
  }
  const exhausted = mockExport(throttled('1'), throttled('1'), throttled('1'));
  await assert.rejects(exhausted.client.read(workspaceId, listId, signal()), hasCode('RATE_LIMITED'));
  const pending = mockExport(start(), ...Array.from({ length: 15 }, () => Response.json({ ok: true, status: 'PENDING' })));
  await assert.rejects(pending.client.read(workspaceId, listId, signal()), hasCode('EXPORT_POLL_LIMIT'));
  assert.equal(pending.calls.length, 16);
  const failed = mockExport(start(), Response.json({ ok: true, status: 'FAILED', download_url: url }));
  await assert.rejects(failed.client.read(workspaceId, listId, signal()), hasCode('EXPORT_FAILED'));
  assert.equal(failed.calls.length, 2);
});
