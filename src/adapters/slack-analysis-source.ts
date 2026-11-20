import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import type { SlackCollectedRequest, SlackConnectionState, SlackReceiverConfig } from '../domain/slack.js';
import { assertRuntimeFile } from '../policy/runtime-path.js';

export interface SlackAnalysisSourceItem {
  request: SlackCollectedRequest;
  receivedAt: string;
  expiresAt: string;
}
export interface SlackAnalysisSource {
  list(now: Date, since: Date): SlackAnalysisSourceItem[];
  find(workspaceId: string, channelId: string, messageTs: string, now: Date): SlackAnalysisSourceItem | null;
  connection(): SlackConnectionState | null;
}
const fail = (): never => { throw new HarnessError('SLACK_ANALYSIS_SOURCE_INVALID'); };
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const readRecord = (row: Record<string, unknown> | undefined): SlackAnalysisSourceItem | null => {
  if (!row) return null;
  if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > 131_072
    || !timestamp(row.expires_at) || !timestamp(row.received_at)) return fail();
  try {
    const request = JSON.parse(row.payload) as SlackCollectedRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || !['workspaceId', 'channelId', 'requesterId', 'eventId'].every(key =>
        typeof request[key as keyof SlackCollectedRequest] === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/u.test(request[key as keyof SlackCollectedRequest] as string))
      || ![request.messageTs, request.threadTs, request.revision].every(value => typeof value === 'string' && /^\d{1,20}\.\d{1,10}$/u.test(value))
      || !['RECEIVED', 'RECORDED', 'INVALIDATED', 'BLOCKED'].includes(request.status)
      || !timestamp(request.updatedAt)) return fail();
    return { request, receivedAt: row.received_at, expiresAt: row.expires_at };
  } catch { return fail(); }
};

/** Read-only connection to the receiver's inbox. It never claims events or changes their retention. */
export class SqliteSlackAnalysisSource implements SlackAnalysisSource {
  private readonly database: DatabaseSync;
  private readonly identity: { dev: number; ino: number };
  constructor(private readonly path: string, private readonly config: SlackReceiverConfig) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) assertRuntimeFile(path + suffix);
    const metadata = lstatSync(path);
    if (realpathSync(path) !== path || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o600) fail();
    this.identity = { dev: metadata.dev, ino: metadata.ino };
    this.database = new DatabaseSync(path, { readOnly: true });
    this.database.exec('PRAGMA busy_timeout = 500; PRAGMA query_only = ON');
  }
  private assertIdentity(): void {
    const current = lstatSync(this.path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid?.()
      || (current.mode & 0o7777) !== 0o600 || current.dev !== this.identity.dev || current.ino !== this.identity.ino) fail();
  }
  list(now: Date, since: Date): SlackAnalysisSourceItem[] {
    this.assertIdentity();
    const rows = this.database.prepare(`SELECT r.payload, r.expires_at, i.received_at FROM slack_requests r
      JOIN slack_inbox i ON i.workspace_id = r.workspace_id AND i.event_id = json_extract(r.payload, '$.eventId')
      WHERE r.workspace_id = ? AND r.payload IS NOT NULL AND r.expires_at > ? AND i.received_at >= ?
      AND json_extract(r.payload, '$.status') = 'RECORDED' ORDER BY i.received_at, r.message_ts LIMIT 100`)
      .all(this.config.workspaceId, now.toISOString(), since.toISOString());
    return rows.map(row => readRecord(row)!).filter(item => this.config.channelIds.includes(item.request.channelId));
  }
  find(workspaceId: string, channelId: string, messageTs: string, now: Date): SlackAnalysisSourceItem | null {
    if (workspaceId !== this.config.workspaceId || !this.config.channelIds.includes(channelId)) return null;
    this.assertIdentity();
    return readRecord(this.database.prepare(`SELECT r.payload, r.expires_at, i.received_at FROM slack_requests r
      JOIN slack_inbox i ON i.workspace_id = r.workspace_id AND i.event_id = json_extract(r.payload, '$.eventId')
      WHERE r.workspace_id = ? AND r.channel_id = ? AND r.message_ts = ? AND r.payload IS NOT NULL AND r.expires_at > ?`)
      .get(workspaceId, channelId, messageTs, now.toISOString()));
  }
  connection(): SlackConnectionState | null {
    this.assertIdentity();
    const row = this.database.prepare('SELECT payload FROM slack_connection WHERE singleton = 1').get();
    if (!row) return null;
    if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > 4096) return fail();
    try {
      const value = JSON.parse(row.payload) as SlackConnectionState;
      if (!value || !['connected', 'gap'].includes(value.state) || !timestamp(value.at)
        || typeof value.reason !== 'string' || value.reason.length > 128) return fail();
      return value;
    } catch { return fail(); }
  }
  close(): void { this.database.close(); }
}
