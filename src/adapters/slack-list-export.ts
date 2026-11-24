import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError, SlackListApiError } from '../domain/errors.js';
import { asSlackRecord } from '../policy/slack-ingestion.js';

const maxApiBytes = 16_384;
const maxExportBytes = 8 * 1024 * 1024;
const maxStatusChecks = 15;
const maxRateRetries = 2;
const apiErrors = new Set([
  'missing_scope', 'list_not_found', 'job_not_found', 'access_denied', 'no_permission', 'permission_denied',
  'invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'not_allowed_token_type',
  'account_inactive', 'accesslimited', 'enterprise_is_restricted', 'ratelimited',
]);

interface SlackListExportOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
}

class SlackListExportError extends HarnessError {
  constructor(code: string, readonly httpStatus?: number) { super(code); }
}
class SlackListRequestError extends SlackListApiError {}
const fail = (code: string, httpStatus?: number): never => { throw new SlackListExportError(`SLACK_LIST_${code}`, httpStatus); };

const transportReasons = new Map<string, string>([
  ['ENOTFOUND', 'DNS_FAILED'], ['EAI_AGAIN', 'DNS_FAILED'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_FAILED'], ['CERT_HAS_EXPIRED', 'TLS_FAILED'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS_FAILED'], ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS_FAILED'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_FAILED'], ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS_FAILED'],
  ['ECONNRESET', 'CONNECTION_FAILED'], ['ECONNREFUSED', 'CONNECTION_FAILED'], ['UND_ERR_SOCKET', 'CONNECTION_FAILED'],
  ['ETIMEDOUT', 'CONNECTION_TIMEOUT'], ['UND_ERR_CONNECT_TIMEOUT', 'CONNECTION_TIMEOUT'],
  ['UND_ERR_HEADERS_TIMEOUT', 'CONNECTION_TIMEOUT'], ['UND_ERR_BODY_TIMEOUT', 'CONNECTION_TIMEOUT'],
]);

/** fetch나 응답 스트림의 예외에는 URL이 포함될 수 있어 고정 분류와 호출 단계만 전달한다. */
const runSlackRequest = async <T>(method: SlackListApiError['method'], request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    if (error instanceof SlackListExportError) throw new SlackListRequestError(error.code, method, error.httpStatus);
    const cause = error instanceof Error ? error.cause : undefined;
    const code = asSlackRecord(cause)?.code ?? asSlackRecord(error)?.code;
    const reason = typeof code === 'string' && !(error instanceof HarnessError) ? transportReasons.get(code) : undefined;
    throw new SlackListRequestError(`SLACK_LIST_${reason ?? 'REQUEST_FAILED'}`, method);
  }
};

/** 내보내기 주소에 인증을 전달하는 범위를 설정한 리스트의 Slack 전용 파일 경로로 한정한다. */
const getDownloadUrl = (raw: unknown, workspaceId: string, listId: string): string => {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\\#]/.test(raw)) return fail('INVALID_DOWNLOAD_URL');
  const match = /^https:\/\/(files\.slack\.com|slack\.com)(\/[^?]+)(?:\?.*)?$/.exec(raw);
  const path = match?.[2];
  if (!path) return fail('INVALID_DOWNLOAD_URL');
  const url = new URL(raw);
  const teams = url.searchParams.getAll('origin_team');
  if (teams.some(team => team !== workspaceId)) return fail('INVALID_DOWNLOAD_URL');
  const directories = [`/files-pri/${workspaceId}-${listId}/`];
  // Slack의 download.get 예시는 경로의 팀 ID에서 T를 생략하고 origin_team에 전체 ID를 담는다.
  if (workspaceId.startsWith('T') && teams.length === 1) directories.push(`/files-pri/${workspaceId.slice(1)}-${listId}/`);
  const directory = directories.find(prefix => path.startsWith(prefix));
  if (!directory || !path.slice(directory.length).split('/').every(segment => /^[\w-]+(?:\.[\w-]+)*$/.test(segment))) {
    return fail('INVALID_DOWNLOAD_URL');
  }
  return raw;
};

const parseResponse = async (response: Response, maximum: number, signal: AbortSignal): Promise<unknown> => {
  if (Number(response.headers.get('content-length')) > maximum) {
    void response.body?.cancel().catch(() => {});
    return fail('RESPONSE_TOO_LARGE');
  }
  if (!response.body) return fail('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const bytes = Buffer.allocUnsafe(maximum);
  let length = 0;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximum - length) {
        cancel();
        return fail('RESPONSE_TOO_LARGE');
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    signal.throwIfAborted();
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
    } catch {
      return fail('INVALID_RESPONSE');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
};

/** API 메타데이터와 내보낸 원문은 요청 처리 중에만 메모리에 보관한다. */
export class SlackListExportClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number;
  private active = false;

  constructor(private readonly webToken: string, options: SlackListExportOptions = {}) {
    if (typeof webToken !== 'string' || !webToken || webToken.length > 4096 || /\s/.test(webToken)) fail('INVALID_CREDENTIALS');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) fail('INVALID_LIMIT');
  }

  async read(workspaceId: string, listId: string, signal: AbortSignal): Promise<unknown> {
    if (typeof workspaceId !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(workspaceId)
      || typeof listId !== 'string' || !/^F[A-Z0-9_]{1,127}$/.test(listId)) return fail('INVALID_TARGET');
    if (signal.aborted) return fail('CANCELLED');
    if (this.active) return fail('EXPORT_IN_PROGRESS');
    this.active = true;
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), this.timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    const aborted = new Promise<never>((_resolve, reject) => {
      combined.addEventListener('abort', () => reject(new HarnessError('SLACK_LIST_CANCELLED')), { once: true });
    });
    try {
      return await Promise.race([this.readExport(workspaceId, listId, combined), aborted]);
    } catch (error) {
      if (signal.aborted) return fail('CANCELLED');
      if (deadline.signal.aborted) return fail('TIMEOUT');
      if (error instanceof SlackListRequestError) throw new SlackListApiError(error.code, error.method, error.httpStatus);
      if (error instanceof SlackListExportError) throw error;
      return fail('REQUEST_FAILED');
    } finally {
      clearTimeout(timeout);
      deadline.abort();
      this.active = false;
    }
  }

  private async readExport(workspaceId: string, listId: string, signal: AbortSignal): Promise<unknown> {
    const options = { list_id: listId, format: 'json', include_threads: true, include_attachments: false, include_archived: false };
    const start = await this.callApi('start', options, signal);
    if (typeof start.job_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(start.job_id)) return fail('INVALID_RESPONSE');
    for (let attempt = 0; attempt < maxStatusChecks; attempt++) {
      if (attempt) await this.sleep(2000, signal);
      const status = await this.callApi('get', { ...options, job_id: start.job_id }, signal);
      if (status.status === 'COMPLETED') {
        return runSlackRequest('file.download', () =>
          this.requestJson(getDownloadUrl(status.download_url, workspaceId, listId), null, maxExportBytes, signal));
      }
      if (typeof status.status !== 'string' || !/^[A-Z_]{1,40}$/.test(status.status)
        || ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(status.status)) {
        return fail('EXPORT_FAILED');
      }
    }
    return fail('EXPORT_POLL_LIMIT');
  }

  private async callApi(method: 'start' | 'get', payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const apiMethod = `slackLists.download.${method}` as const;
    return runSlackRequest(apiMethod, async () => {
      const parsed = asSlackRecord(await this.requestJson(`https://slack.com/api/${apiMethod}`, JSON.stringify(payload), maxApiBytes, signal));
      if (!parsed || typeof parsed.ok !== 'boolean') return fail('INVALID_RESPONSE');
      if (parsed.ok) return parsed;
      const reason = typeof parsed.error === 'string' && apiErrors.has(parsed.error) ? parsed.error.toUpperCase() : 'REJECTED';
      return fail(`API_${reason}`);
    });
  }

  private async requestJson(url: string, body: string | null, maximum: number, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt <= maxRateRetries; attempt++) {
      signal.throwIfAborted();
      const response = await this.fetch(url, {
        method: body === null ? 'GET' : 'POST', redirect: 'manual', credentials: 'omit', signal,
        headers: { Authorization: `Bearer ${this.webToken}`, ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
        body,
      });
      if (signal.aborted || response.redirected || !response.ok) {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
        if (response.redirected || [301, 302, 303, 307, 308].includes(response.status)) return fail('REDIRECT_DENIED', response.status);
        if (response.status === 401) return fail('HTTP_UNAUTHORIZED', response.status);
        if (response.status === 403) return fail('HTTP_FORBIDDEN', response.status);
        if (response.status !== 429) return fail('HTTP_FAILED', response.status);
        const retryHeader = response.headers.get('retry-after') ?? '';
        const seconds = Number(retryHeader);
        if (!/^\d{1,2}$/.test(retryHeader) || seconds > 60 || attempt === maxRateRetries) return fail('RATE_LIMITED', response.status);
        await this.sleep(Math.max(1, seconds) * 1000, signal);
        continue;
      }
      return parseResponse(response, maximum, signal);
    }
    return fail('RATE_LIMITED');
  }
}
