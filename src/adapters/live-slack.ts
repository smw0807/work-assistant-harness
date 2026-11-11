import { HarnessError } from '../domain/errors.js';
import type { LiveSlackPort } from '../ports/live-slack.js';
import { assertLiveClaim, assertLiveConfig, hashLiveContext, liveIdentifier, liveMaxResponseBytes, liveRequestTimeoutMs, liveTestBody, liveTestRootText, liveTimestamp } from '../policy/live-slack-policy.js';

type LiveConfig = Parameters<LiveSlackPort['capture']>[0];
type LiveClaim = Parameters<LiveSlackPort['post']>[0];
type LiveSource = Awaited<ReturnType<LiveSlackPort['capture']>>;
type LiveDeliveryResult = Awaited<ReturnType<LiveSlackPort['post']>>;
type JsonObject = Record<string, unknown>;

const authUrl = 'https://slack.com/api/auth.test';
const repliesUrl = 'https://slack.com/api/conversations.replies';
const postUrl = 'https://slack.com/api/chat.postMessage';
const confirmedRejections = new Set([
  'missing_scope', 'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'no_permission',
  'channel_not_found', 'not_in_channel', 'is_archived', 'restricted_action', 'restricted_action_read_only_channel',
  'restricted_action_non_threadable_channel', 'restricted_action_thread_only_channel', 'restricted_action_thread_locked',
  'msg_too_long', 'no_text', 'invalid_arguments', 'invalid_arg_name', 'invalid_blocks', 'invalid_metadata',
  'thread_not_found', 'ratelimited', 'rate_limited',
]);
const safeCodes = new Set([
  'LIVE_SLACK_REQUEST_CANCELLED', 'LIVE_SLACK_REQUEST_TIMEOUT', 'LIVE_SLACK_RESPONSE_TOO_LARGE',
  'LIVE_SLACK_INVALID_RESPONSE', 'LIVE_SLACK_REDIRECT', 'LIVE_SLACK_INVALID_CLAIM',
]);

const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown, prefix: string): value is string => liveIdentifier(value) && value.startsWith(prefix);
const safeCode = (error: unknown): string => error instanceof HarnessError && safeCodes.has(error.code)
  ? error.code : 'LIVE_SLACK_REQUEST_FAILED';
const cancelBody = (response: Response): void => {
  try { void response.body?.cancel().catch(() => {}); } catch { /* 잠긴 스트림은 reader가 정리한다. */ }
};

const readJson = async (response: Response, signal: AbortSignal): Promise<JsonObject> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > liveMaxResponseBytes)) {
    cancelBody(response);
    throw new HarnessError('LIVE_SLACK_RESPONSE_TOO_LARGE');
  }
  if (response.body === null) throw new HarnessError('LIVE_SLACK_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new HarnessError('LIVE_SLACK_REQUEST_CANCELLED');
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new HarnessError('LIVE_SLACK_REQUEST_CANCELLED');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > liveMaxResponseBytes) {
        cancel();
        throw new HarnessError('LIVE_SLACK_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch {
    throw new HarnessError('LIVE_SLACK_INVALID_RESPONSE');
  }
  if (!isRecord(payload)) throw new HarnessError('LIVE_SLACK_INVALID_RESPONSE');
  return payload;
};

const timestampAfter = (left: string, right: string): boolean => {
  const [leftSeconds = '', leftFraction = ''] = left.split('.');
  const [rightSeconds = '', rightFraction = ''] = right.split('.');
  if (BigInt(leftSeconds) !== BigInt(rightSeconds)) return BigInt(leftSeconds) > BigInt(rightSeconds);
  const length = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(length, '0') > rightFraction.padEnd(length, '0');
};

/** 개인 테스트 스레드의 고정 문구만 전송한다. 승인 영속화와 소비는 호출자가 먼저 끝낸다. */
export class LiveSlackAdapter implements LiveSlackPort {
  private readonly fetch: typeof fetch;
  private readonly clock: () => Date;
  private readonly attemptedIds = new Set<string>();

  constructor(private readonly token: string, dependencies: { fetch?: typeof fetch; clock?: () => Date } = {}) {
    if (typeof token !== 'string' || token.length > 4096 || !/^xoxb-[A-Za-z0-9-]+$/.test(token)) throw new HarnessError('LIVE_SLACK_INVALID_TOKEN');
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async capture(config: LiveConfig, signal?: AbortSignal): Promise<LiveSource> {
    assertLiveConfig(config);
    try {
      const identity = await this.request(authUrl, 'POST', null, signal);
      const scopes = new Set((identity.scopes ?? '').split(',').map((scope) => scope.trim()));
      if (identity.status !== 200 || identity.payload.ok !== true || identity.payload.team_id !== config.workspaceId
        || !isId(identity.payload.bot_id, 'B') || !isId(identity.payload.user_id, 'U')
        || !scopes.has('chat:write') || !scopes.has('channels:history')) throw new HarnessError('LIVE_SLACK_IDENTITY_MISMATCH');
      const parameters = new URLSearchParams({ channel: config.channelId, ts: config.threadTs, limit: '2' });
      const response = await this.request(`${repliesUrl}?${parameters.toString()}`, 'GET', null, signal);
      const root = this.readRoot(response, config);
      return {
        botId: identity.payload.bot_id, botUserId: identity.payload.user_id,
        rootRevision: root.revision, contextHash: hashLiveContext(root), observedAt: this.clock().toISOString(),
      };
    } catch (error: unknown) {
      const captureCodes = new Set(['LIVE_SLACK_IDENTITY_MISMATCH', 'LIVE_SLACK_THREAD_UNAVAILABLE', 'LIVE_SLACK_THREAD_CHANGED', 'LIVE_SLACK_INCOMPLETE_THREAD']);
      throw new HarnessError(error instanceof HarnessError && captureCodes.has(error.code) ? error.code : safeCode(error));
    }
  }

  async post(claim: LiveClaim, signal?: AbortSignal): Promise<LiveDeliveryResult> {
    const result = (status: LiveDeliveryResult['status'], reason: string | null, receipt: LiveDeliveryResult['receipt'] = null): LiveDeliveryResult => ({ status, reason, receipt });
    let dispatched = false;
    try {
      try { assertLiveClaim(claim, this.clock()); } catch { throw new HarnessError('LIVE_SLACK_INVALID_CLAIM'); }
      if (signal?.aborted) throw new HarnessError('LIVE_SLACK_REQUEST_CANCELLED');
      if (this.attemptedIds.has(claim.attempt.attemptId)) return result('UNKNOWN', 'LIVE_SLACK_ALREADY_ATTEMPTED');
      this.attemptedIds.add(claim.attempt.attemptId);
      const config = claim.task.plan.config;
      const body = JSON.stringify({
        channel: config.channelId, thread_ts: config.threadTs, text: liveTestBody,
        reply_broadcast: false, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
      });
      dispatched = true;
      const response = await this.request(postUrl, 'POST', body, signal);
      if (response.status === 429) return result('NOT_SENT', 'LIVE_SLACK_RATE_LIMITED');
      if (response.status >= 500) return result('UNKNOWN', 'LIVE_SLACK_HTTP_UNCERTAIN');
      if (response.payload.ok === false) {
        return !('ts' in response.payload) && !('message' in response.payload) && typeof response.payload.error === 'string'
          && confirmedRejections.has(response.payload.error)
          ? result('NOT_SENT', 'LIVE_SLACK_API_REJECTED') : result('UNKNOWN', 'LIVE_SLACK_API_UNCERTAIN');
      }
      if (response.status !== 200) return result('UNKNOWN', 'LIVE_SLACK_HTTP_UNCERTAIN');
      const message = response.payload.message;
      if (response.payload.ok !== true || response.payload.channel !== config.channelId || !liveTimestamp(response.payload.ts)
        || !timestampAfter(response.payload.ts, config.threadTs) || !isRecord(message)
        || message.ts !== response.payload.ts || message.thread_ts !== config.threadTs
        || message.bot_id !== claim.task.plan.source.botId || message.user !== claim.task.plan.source.botUserId
        || message.text !== liveTestBody || message.subtype === 'thread_broadcast' || message.reply_broadcast === true
        || message.hidden === true) return result('UNKNOWN', 'LIVE_SLACK_RECEIPT_MISMATCH');
      return result('SENT', null, { channelId: config.channelId, messageTs: response.payload.ts, threadTs: config.threadTs });
    } catch (error: unknown) {
      return result(dispatched ? 'UNKNOWN' : 'NOT_SENT', safeCode(error));
    }
  }

  private readRoot(response: { status: number; payload: JsonObject }, config: LiveConfig): { ts: string; user: string; text: string; revision: string } {
    if (response.status !== 200 || response.payload.ok !== true) throw new HarnessError('LIVE_SLACK_THREAD_UNAVAILABLE');
    const payload = response.payload;
    const metadata = payload.response_metadata;
    if ((payload.has_more !== undefined && payload.has_more !== false)
      || (payload.is_limited !== undefined && payload.is_limited !== false)
      || (metadata !== undefined && (!isRecord(metadata) || (metadata.next_cursor !== undefined && metadata.next_cursor !== '')))
      || !Array.isArray(payload.messages) || payload.messages.length !== 1) throw new HarnessError('LIVE_SLACK_INCOMPLETE_THREAD');
    const message: unknown = payload.messages[0];
    if (!isRecord(message) || message.ts !== config.threadTs || !isId(message.user, 'U') || message.text !== liveTestRootText
      || message.subtype !== undefined || message.bot_id !== undefined || message.hidden !== undefined
      || (message.thread_ts !== undefined && message.thread_ts !== config.threadTs)
      || (message.reply_count !== undefined && message.reply_count !== 0)
      || (message.reply_users_count !== undefined && message.reply_users_count !== 0)
      || (message.reply_users !== undefined && (!Array.isArray(message.reply_users) || message.reply_users.length !== 0))
      || message.latest_reply !== undefined) throw new HarnessError('LIVE_SLACK_THREAD_CHANGED');
    const edited = message.edited;
    if (edited !== undefined && (!isRecord(edited) || !liveTimestamp(edited.ts))) throw new HarnessError('LIVE_SLACK_THREAD_CHANGED');
    return { ts: config.threadTs, user: message.user, text: liveTestRootText, revision: isRecord(edited) ? String(edited.ts) : config.threadTs };
  }

  private async request(url: string, method: 'GET' | 'POST', body: string | null, signal?: AbortSignal): Promise<{ status: number; payload: JsonObject; scopes: string | null }> {
    if (signal?.aborted) throw new HarnessError('LIVE_SLACK_REQUEST_CANCELLED');
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled: ((error: HarnessError) => void) | undefined;
    const abort = (): void => {
      rejectCancelled?.(new HarnessError('LIVE_SLACK_REQUEST_CANCELLED'));
      controller.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectCancelled = reject;
        timeout = setTimeout(() => {
          reject(new HarnessError('LIVE_SLACK_REQUEST_TIMEOUT'));
          controller.abort();
        }, liveRequestTimeoutMs);
      });
      if (signal?.aborted) abort();
      const operation = (async () => {
        const response = await this.fetch(url, {
          method, body, signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json; charset=utf-8' },
        });
        if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
          || (response.url !== '' && response.url !== url)) {
          cancelBody(response);
          throw new HarnessError('LIVE_SLACK_REDIRECT');
        }
        const scopes = response.headers.get('x-oauth-scopes');
        if (response.status === 429 || response.status >= 500) {
          cancelBody(response);
          return { status: response.status, payload: {}, scopes };
        }
        return { status: response.status, payload: await readJson(response, controller.signal), scopes };
      })();
      return await Promise.race([operation, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}
