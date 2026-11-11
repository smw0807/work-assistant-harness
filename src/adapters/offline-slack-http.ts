import { HarnessError } from '../domain/errors.js';
import { slackPostFixtures, type SlackPostFixture } from '../domain/slack-post.js';
import type { SlackPostHttpPort, SlackPostHttpRequest } from '../ports/slack-post.js';
import { defaultSlackPostConfig, offlinePostBody, offlineThreadMessages } from '../policy/slack-post-policy.js';

const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const messageUrl = 'https://slack.com/api/chat.postMessage';
const identityUrl = 'https://slack.com/api/auth.test';
const threadUrl = 'https://slack.com/api/conversations.replies';

/** 메모리의 Response만 반환하며 HTTP client·실제 토큰·외부 I/O는 갖지 않는다. */
export class OfflineSlackHttp implements SlackPostHttpPort {
  readonly mode = 'offline' as const;

  constructor(private readonly fixture: SlackPostFixture) {
    if (!slackPostFixtures.includes(fixture)) throw new HarnessError('SLACK_POST_INVALID_FIXTURE');
  }

  async request(request: SlackPostHttpRequest): Promise<Response> {
    this.assertRequest(request);
    if (request.signal.aborted) throw new HarnessError('SLACK_POST_REQUEST_CANCELLED');
    if (this.fixture === 'disabled') throw new HarnessError('SLACK_POST_DISABLED');
    if (request.url === identityUrl) {
      return jsonResponse({
        ok: true, team_id: this.fixture === 'auth-mismatch' ? 'W_OTHER' : defaultSlackPostConfig.workspaceId,
        user_id: defaultSlackPostConfig.botUserId, bot_id: defaultSlackPostConfig.botId,
      });
    }
    if (request.url.startsWith(`${threadUrl}?`)) return this.threadResponse();
    switch (this.fixture) {
      case 'denied': return jsonResponse({ ok: false, error: 'missing_scope' });
      case 'rate-limited': return new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
      case 'server-error': return new Response(null, { status: 503 });
      case 'timeout': return new Promise<Response>(() => {});
      case 'malformed': return new Response('invalid-json');
      case 'oversized': return new Response('x'.repeat(defaultSlackPostConfig.maxResponseBytes + 1));
      case 'redirect': return new Response(null, { status: 302, headers: { Location: 'https://synthetic.invalid/' } });
      default: return jsonResponse({
        ok: true, channel: this.fixture === 'receipt-mismatch' ? 'C_OTHER' : defaultSlackPostConfig.channelId,
        ts: '1700000001.000001',
        message: {
          ts: '1700000001.000001', thread_ts: offlineThreadMessages[0]?.ts,
          user: defaultSlackPostConfig.botUserId, bot_id: defaultSlackPostConfig.botId, text: offlinePostBody,
        },
      });
    }
  }

  private threadResponse(): Response {
    const messages = offlineThreadMessages.map((message) => ({ ...message }));
    if (this.fixture === 'source-changed' && messages[1] !== undefined) {
      messages[1].text = '합성 요청이 변경되었습니다.';
      messages[1].revision = '1700000000.000099';
    }
    if (this.fixture === 'new-reply') messages.push({
      ts: '1700000000.000003', user: 'U_SYNTHETIC_REPLY', text: '새 합성 답글입니다.', revision: '1700000000.000003',
    });
    return jsonResponse({
      ok: true, messages: messages.map(({ revision, ...message }) => ({ ...message, edited: { ts: revision } })),
      has_more: this.fixture === 'incomplete',
      response_metadata: { next_cursor: this.fixture === 'incomplete' ? 'synthetic-next-page' : '' },
    });
  }

  private assertRequest(request: SlackPostHttpRequest): void {
    const headers = new Headers(request.headers);
    if (request.redirect !== 'error' || headers.get('authorization') !== 'Bearer SYNTHETIC_OFFLINE_TOKEN'
      || headers.get('content-type') !== 'application/json; charset=utf-8'
      || [...headers.keys()].some((key) => key !== 'authorization' && key !== 'content-type')) {
      throw new HarnessError('SLACK_POST_INVALID_HTTP_REQUEST');
    }
    if (request.url === identityUrl && request.method === 'POST' && request.body === null) return;
    const expectedThreadUrl = `${threadUrl}?${new URLSearchParams({ channel: defaultSlackPostConfig.channelId, ts: offlineThreadMessages[0]?.ts ?? '' }).toString()}`;
    if (request.url === expectedThreadUrl && request.method === 'GET' && request.body === null) return;
    if (request.url !== messageUrl || request.method !== 'POST' || typeof request.body !== 'string') {
      throw new HarnessError('SLACK_POST_INVALID_HTTP_REQUEST');
    }
    let body: unknown;
    try { body = JSON.parse(request.body) as unknown; } catch { throw new HarnessError('SLACK_POST_INVALID_HTTP_REQUEST'); }
    const expectedBody = {
      channel: defaultSlackPostConfig.channelId, text: offlinePostBody, thread_ts: offlineThreadMessages[0]?.ts,
      reply_broadcast: false, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
    };
    if (!isRecord(body) || Object.keys(body).length !== Object.keys(expectedBody).length
      || Object.entries(expectedBody).some(([key, value]) => !isRecord(body) || body[key] !== value)) {
      throw new HarnessError('SLACK_POST_INVALID_HTTP_REQUEST');
    }
  }
}
