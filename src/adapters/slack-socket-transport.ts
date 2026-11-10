import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError } from '../domain/errors.js';

export const SLACK_SOCKET_HOSTS = ['wss.slack.com', 'wss-primary.slack.com', 'wss-backup.slack.com'] as const;
const maxEnvelopeBytes = 131_072;
const maxPendingEnvelopes = 100;

export const validateSlackSocketUrl = (input: string): string => {
  let url: URL;
  try {
    if (typeof input !== 'string' || input.length > 8192 || /[\s\\]/.test(input)) throw new Error();
    url = new URL(input);
    const authority = /^wss:\/\/([^/?#]+)/i.exec(input)?.[1];
    if (authority === undefined || /[:@]/.test(authority) || url.protocol !== 'wss:' || url.hash !== ''
      || url.username !== '' || url.password !== '' || url.port !== ''
      || !SLACK_SOCKET_HOSTS.some((host) => host === url.hostname)) throw new Error();
  } catch {
    throw new HarnessError('SLACK_INVALID_SOCKET_URL');
  }
  return url.href;
};

export interface SlackSocketConnection {
  readonly readyState: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  send(data: string): void;
  close(code?: number): void;
}

interface SlackSocketDependencies {
  createSocket?: (url: string) => SlackSocketConnection;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  maxReconnects?: number;
  connectTimeoutMs?: number;
}

type EnvelopeHandler = (input: unknown, ack: () => Promise<void>) => Promise<void>;
type ConnectionHandler = (state: 'connected' | 'gap', reason: string) => void;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export class SlackSocketTransport {
  private readonly createSocket: (url: string) => SlackSocketConnection;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly maxReconnects: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly client: { openSocket(signal?: AbortSignal): Promise<string> }, dependencies: SlackSocketDependencies = {}) {
    this.createSocket = dependencies.createSocket ?? ((url) => new WebSocket(url));
    this.sleep = dependencies.sleep ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); });
    this.maxReconnects = dependencies.maxReconnects ?? 5;
    this.connectTimeoutMs = dependencies.connectTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.maxReconnects) || this.maxReconnects < 0 || this.maxReconnects > 20
      || !Number.isInteger(this.connectTimeoutMs) || this.connectTimeoutMs < 1 || this.connectTimeoutMs > 60_000) {
      throw new HarnessError('SLACK_INVALID_LIMIT');
    }
  }

  async run(onEnvelope: EnvelopeHandler, signal: AbortSignal, onConnection: ConnectionHandler): Promise<void> {
    for (let attempt = 0; !signal.aborted; attempt += 1) {
      let reason: string;
      try {
        const url = validateSlackSocketUrl(await this.openSocket(signal));
        if (signal.aborted) return;
        reason = await this.receive(this.createSocket(url), onEnvelope, signal, onConnection);
      } catch (error: unknown) {
        reason = error instanceof HarnessError ? error.code : 'SLACK_SOCKET_CONNECTION_FAILED';
      }
      if (signal.aborted) return;
      try { onConnection('gap', reason); } catch { throw new HarnessError('SLACK_CONNECTION_REPORT_FAILED'); }
      if (attempt >= this.maxReconnects) throw new HarnessError('SLACK_RECONNECT_LIMIT');
      try { await this.sleep(Math.min(30_000, 1000 * 2 ** attempt), signal); } catch {
        if (signal.aborted) return;
        throw new HarnessError('SLACK_RECONNECT_FAILED');
      }
    }
  }

  private async openSocket(signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const abort = (): void => { reject(new HarnessError('SLACK_SOCKET_STOPPED')); };
      signal.addEventListener('abort', abort, { once: true });
      this.client.openSocket(signal).then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); });
      if (signal.aborted) abort();
    });
  }

  private async receive(socket: SlackSocketConnection, onEnvelope: EnvelopeHandler, signal: AbortSignal, onConnection: ConnectionHandler): Promise<string> {
    return new Promise<string>((resolve) => {
      let settled = false;
      let pendingCount = 0;
      let pendingBytes = 0;
      let queue = Promise.resolve();
      const close = (reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        signal.removeEventListener('abort', abort);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', disconnected);
        socket.removeEventListener('error', failed);
        try { socket.close(); } catch { /* The connection is already unavailable. */ }
        resolve(reason);
      };
      const abort = (): void => { close('SLACK_SOCKET_STOPPED'); };
      const opened: EventListener = () => {
        clearTimeout(connectTimeout);
        try { onConnection('connected', 'SLACK_SOCKET_CONNECTED'); } catch { close('SLACK_CONNECTION_REPORT_FAILED'); }
      };
      const disconnected: EventListener = () => { close('SLACK_SOCKET_DISCONNECTED'); };
      const failed: EventListener = () => { close('SLACK_SOCKET_ERROR'); };
      const message: EventListener = (event) => {
        if (settled || signal.aborted) return;
        const data = (event as MessageEvent).data as unknown;
        if (typeof data !== 'string' || Buffer.byteLength(data) > maxEnvelopeBytes) {
          close('SLACK_SOCKET_MESSAGE_LIMIT');
          return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(data) as unknown; } catch {
          close('SLACK_SOCKET_INVALID_JSON');
          return;
        }
        if (!isRecord(parsed)) { close('SLACK_SOCKET_INVALID_MESSAGE'); return; }
        if (parsed.type === 'hello') return;
        if (parsed.type === 'disconnect') { close('SLACK_SOCKET_REFRESH'); return; }
        if (typeof parsed.envelope_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.envelope_id)) {
          close('SLACK_SOCKET_INVALID_ENVELOPE');
          return;
        }
        pendingCount += 1;
        pendingBytes += Buffer.byteLength(data);
        if (pendingCount > maxPendingEnvelopes || pendingBytes > maxEnvelopeBytes * 4) {
          close('SLACK_SOCKET_QUEUE_LIMIT');
          return;
        }
        const envelopeId = parsed.envelope_id;
        let acknowledged = false;
        const ack = async (): Promise<void> => {
          if (acknowledged) return;
          if (settled || signal.aborted || socket.readyState !== 1) throw new HarnessError('SLACK_ACK_UNAVAILABLE');
          try { socket.send(JSON.stringify({ envelope_id: envelopeId })); } catch { throw new HarnessError('SLACK_ACK_FAILED'); }
          acknowledged = true;
        };
        // Intake controls ACK timing; the transport never acknowledges failed persistence.
        queue = queue.then(async () => {
          if (!settled && !signal.aborted) await onEnvelope(parsed, ack);
        }).catch(() => { close('SLACK_SOCKET_HANDLER_FAILED'); }).finally(() => {
          pendingCount -= 1;
          pendingBytes -= Buffer.byteLength(data);
        });
      };
      const connectTimeout = setTimeout(() => { close('SLACK_SOCKET_CONNECT_TIMEOUT'); }, this.connectTimeoutMs);
      socket.addEventListener('open', opened);
      socket.addEventListener('message', message);
      socket.addEventListener('close', disconnected);
      socket.addEventListener('error', failed);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (socket.readyState === 1) opened(new Event('open'));
    });
  }
}
