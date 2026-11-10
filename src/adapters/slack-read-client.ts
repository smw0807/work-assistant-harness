import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError } from '../domain/errors.js';
import { validateSlackSocketUrl } from './slack-socket-transport.js';

const maxResponseBytes = 262_144;
const maxRetryDelayMs = 60_000;
const timestampPattern = /^\d{1,20}\.\d{1,20}$/;
const identifierPattern = /^[A-Za-z0-9_]{1,128}$/;

export interface SlackThreadLimits {
  maxMessages: number;
  maxPages: number;
  maxBytes: number;
}

export interface SlackThreadResult {
  messages: { ts: string; user: string; text: string }[];
  complete: boolean;
  reason: string | null;
}

interface SlackReadOptions {
  appToken: string;
  webToken: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

interface SlackReadDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const validateInteger = (value: number, minimum: number, maximum: number): number => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new HarnessError('SLACK_INVALID_LIMIT');
  return value;
};

const cancellable = async <T>(operation: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> => {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort?.();
      reject(new HarnessError('SLACK_REQUEST_CANCELLED'));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); });
    if (signal.aborted) abort();
  });
};

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxResponseBytes) {
    await response.body?.cancel();
    throw new HarnessError('SLACK_RESPONSE_TOO_LARGE');
  }
  if (response.body === null) throw new HarnessError('SLACK_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new HarnessError('SLACK_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HarnessError('SLACK_INVALID_RESPONSE');
  }
  if (!isRecord(parsed)) throw new HarnessError('SLACK_INVALID_RESPONSE');
  return parsed;
};

/** Only the three fixed metadata/read/intake operations below can reach the Slack Web API. */
export class SlackReadClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: SlackReadOptions, dependencies: SlackReadDependencies = {}) {
    if (![options.appToken, options.webToken].every((token) => typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/\s/.test(token))) {
      throw new HarnessError('SLACK_INVALID_CREDENTIALS');
    }
    this.requestTimeoutMs = validateInteger(options.requestTimeoutMs ?? 10_000, 1, 60_000);
    this.maxRetries = validateInteger(options.maxRetries ?? 2, 0, 5);
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.sleep = dependencies.sleep ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); });
  }

  async openSocket(signal?: AbortSignal): Promise<string> {
    const response = await this.request('socket', new URLSearchParams(), signal);
    if (typeof response.url !== 'string') throw new HarnessError('SLACK_INVALID_SOCKET_URL');
    return validateSlackSocketUrl(response.url);
  }

  async verifyWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void> {
    if (!identifierPattern.test(workspaceId)) throw new HarnessError('SLACK_INVALID_WORKSPACE');
    const response = await this.request('identity', new URLSearchParams(), signal);
    if (typeof response.team_id !== 'string' || !identifierPattern.test(response.team_id)) {
      throw new HarnessError('SLACK_INVALID_RESPONSE');
    }
    if (response.team_id !== workspaceId) throw new HarnessError('SLACK_WORKSPACE_MISMATCH');
  }

  async readThread(channelId: string, threadTs: string, requestedLimits?: SlackThreadLimits, signal?: AbortSignal): Promise<SlackThreadResult> {
    if (!identifierPattern.test(channelId) || !timestampPattern.test(threadTs)) throw new HarnessError('SLACK_INVALID_THREAD');
    const limits = requestedLimits ?? { maxMessages: 50, maxPages: 5, maxBytes: 65_536 };
    validateInteger(limits.maxMessages, 1, 200);
    validateInteger(limits.maxPages, 1, 20);
    validateInteger(limits.maxBytes, 1, maxResponseBytes);
    const messages: SlackThreadResult['messages'] = [];
    const seenCursors = new Set<string>();
    let cursor = '';
    let totalBytes = 2;
    let unsupportedMessage = false;
    const incomplete = (reason: string): SlackThreadResult => ({ messages, complete: false, reason });
    if (signal?.aborted) return incomplete('SLACK_REQUEST_CANCELLED');
    if (totalBytes > limits.maxBytes) return incomplete('SLACK_THREAD_BYTE_LIMIT');
    for (let page = 0; page < limits.maxPages; page += 1) {
      if (signal?.aborted) return incomplete('SLACK_REQUEST_CANCELLED');
      let response: Record<string, unknown>;
      try {
        response = await this.request('thread', new URLSearchParams({
          channel: channelId, ts: threadTs, limit: String(Math.min(100, limits.maxMessages - messages.length)),
          ...(cursor === '' ? {} : { cursor }),
        }), signal);
      } catch (error: unknown) {
        return incomplete(error instanceof HarnessError ? error.code : 'SLACK_THREAD_READ_FAILED');
      }
      if (signal?.aborted) return incomplete('SLACK_REQUEST_CANCELLED');
      if (!Array.isArray(response.messages)) return incomplete('SLACK_INVALID_RESPONSE');
      for (const rawMessage of response.messages as unknown[]) {
        if (!isRecord(rawMessage) || typeof rawMessage.ts !== 'string' || !timestampPattern.test(rawMessage.ts)
          || typeof rawMessage.user !== 'string' || !identifierPattern.test(rawMessage.user) || typeof rawMessage.text !== 'string') {
          unsupportedMessage = true;
          continue;
        }
        if (messages.length >= limits.maxMessages) return incomplete('SLACK_THREAD_MESSAGE_LIMIT');
        const message = { ts: rawMessage.ts, user: rawMessage.user, text: rawMessage.text };
        totalBytes += Buffer.byteLength(JSON.stringify(message)) + (messages.length > 0 ? 1 : 0);
        if (totalBytes > limits.maxBytes) return incomplete('SLACK_THREAD_BYTE_LIMIT');
        messages.push(message);
      }
      const metadata = response.response_metadata;
      if (metadata !== undefined && !isRecord(metadata)) return incomplete('SLACK_INVALID_RESPONSE');
      const nextCursor = isRecord(metadata) ? metadata.next_cursor : undefined;
      if (nextCursor !== undefined && (typeof nextCursor !== 'string' || nextCursor.length > 2048)) return incomplete('SLACK_INVALID_RESPONSE');
      cursor = typeof nextCursor === 'string' ? nextCursor.trim() : '';
      if (cursor === '') {
        if (response.has_more === true) return incomplete('SLACK_THREAD_MISSING_CURSOR');
        return unsupportedMessage ? incomplete('SLACK_THREAD_UNSUPPORTED_MESSAGE') : { messages, complete: true, reason: null };
      }
      if (seenCursors.has(cursor)) return incomplete('SLACK_THREAD_REPEATED_CURSOR');
      seenCursors.add(cursor);
      if (messages.length >= limits.maxMessages) return incomplete('SLACK_THREAD_MESSAGE_LIMIT');
    }
    return incomplete('SLACK_THREAD_PAGE_LIMIT');
  }

  private async request(operation: 'socket' | 'thread' | 'identity', parameters = new URLSearchParams(), signal?: AbortSignal): Promise<Record<string, unknown>> {
    const apiUrl = {
      socket: 'https://slack.com/api/apps.connections.open',
      thread: 'https://slack.com/api/conversations.replies',
      identity: 'https://slack.com/api/auth.test',
    }[operation];
    const url = operation === 'thread' ? `${apiUrl}?${parameters.toString()}` : apiUrl;
    const token = operation === 'socket' ? this.options.appToken : this.options.webToken;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) throw new HarnessError('SLACK_REQUEST_CANCELLED');
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let retryDelayMs: number | undefined;
      try {
        const result = await cancellable(Promise.race([
          (async () => {
            const response = await this.fetch(url, {
              method: operation === 'thread' ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              ...(operation === 'thread' ? {} : { body: '' }),
            });
            if (response.status === 429) {
              const header = response.headers.get('retry-after');
              await response.body?.cancel();
              const retryAfter = header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : NaN;
              if (!Number.isSafeInteger(retryAfter) || retryAfter > maxRetryDelayMs || attempt === this.maxRetries) throw new HarnessError('SLACK_RATE_LIMITED');
              return { retryAfter: Math.max(1000, retryAfter) };
            }
            if (!response.ok) {
              await response.body?.cancel();
              throw new HarnessError('SLACK_HTTP_FAILED');
            }
            const parsed = await readJson(response);
            if (parsed.ok !== true) throw new HarnessError('SLACK_API_REJECTED');
            return { parsed };
          })(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new HarnessError('SLACK_REQUEST_TIMEOUT'));
            }, this.requestTimeoutMs);
          }),
        ]), signal, () => { controller.abort(); });
        if ('parsed' in result && result.parsed !== undefined) return result.parsed;
        retryDelayMs = result.retryAfter;
      } catch (error: unknown) {
        if (error instanceof HarnessError) throw error;
        throw new HarnessError(controller.signal.aborted ? 'SLACK_REQUEST_TIMEOUT' : 'SLACK_REQUEST_FAILED');
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        controller.abort();
      }
      if (retryDelayMs !== undefined) {
        try { await cancellable(this.sleep(retryDelayMs, signal), signal); } catch {
          throw new HarnessError(signal?.aborted ? 'SLACK_REQUEST_CANCELLED' : 'SLACK_RETRY_FAILED');
        }
      }
    }
    throw new HarnessError('SLACK_RATE_LIMITED');
  }
}
