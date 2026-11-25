import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import { getSlackListIds, type SlackCollectedRequest, type SlackConnectionState, type SlackReceiverConfig } from '../domain/slack.js';
import { assertRuntimeFile } from '../policy/runtime-path.js';

export interface SlackAnalysisSourceItem {
  request: SlackCollectedRequest;
  receivedAt: string;
  expiresAt: string;
}
export interface SlackAnalysisSource {
  list(now: Date, since: Date): Iterable<SlackAnalysisSourceItem>;
  find(workspaceId: string, channelId: string, messageTs: string, now: Date): SlackAnalysisSourceItem | null;
  connection(): SlackConnectionState | null;
}
const fail = (): never => { throw new HarnessError('SLACK_ANALYSIS_SOURCE_INVALID'); };
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const channelRows = `SELECT r.workspace_id, r.channel_id, NULL AS item_id, NULL AS thread_ts, r.message_ts, r.payload, r.expires_at, i.received_at
  FROM slack_requests r JOIN slack_inbox i ON i.workspace_id = r.workspace_id AND i.event_id = json_extract(r.payload, '$.eventId')
  WHERE r.payload IS NOT NULL AND r.workspace_id = ? AND r.expires_at > ?`;
const listRows = `SELECT workspace_id, list_id AS channel_id, item_id, thread_ts, message_ts, payload, expires_at, received_at
  FROM slack_list_analysis_requests WHERE payload IS NOT NULL AND workspace_id = ? AND expires_at > ? AND target_id = ?`;
const readRecord = (row: Record<string, unknown> | undefined): SlackAnalysisSourceItem | null => {
  if (!row) return null;
  // 목록 스냅샷은 제한된 전체 스레드와 그 안의 멘션 원문을 함께 저장한다.
  const maxPayloadBytes = row.item_id === null ? 131_072 : 2 * 65_536 + 4_096;
  if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > maxPayloadBytes
    || !timestamp(row.expires_at) || !timestamp(row.received_at)) return fail();
  try {
    const request = JSON.parse(row.payload) as SlackCollectedRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || !['workspaceId', 'channelId', 'requesterId', 'eventId'].every(key =>
        typeof request[key as keyof SlackCollectedRequest] === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/u.test(request[key as keyof SlackCollectedRequest] as string))
      || ![request.messageTs, request.threadTs, request.revision].every(value => typeof value === 'string' && /^\d{1,20}\.\d{1,10}$/u.test(value))
      || row.workspace_id !== request.workspaceId || row.channel_id !== request.channelId || row.message_ts !== request.messageTs
      || (row.item_id === null ? Object.hasOwn(request, 'listItemId') : row.item_id !== request.listItemId || row.thread_ts !== request.threadTs)
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
  *list(now: Date, since: Date): IterableIterator<SlackAnalysisSourceItem> {
    this.assertIdentity();
    const { channelIds, workspaceId, targetUserId } = this.config;
    const listIds = this.config.listAnalysisEnabled ? getSlackListIds(this.config) : [];
    const queries: string[] = [];
    const params: string[] = [];
    if (channelIds.length) {
      queries.push(`${channelRows} AND i.received_at >= ? AND r.channel_id IN (${channelIds.map(() => '?').join(',')})
        AND json_extract(r.payload, '$.status') = 'RECORDED'`);
      params.push(workspaceId, now.toISOString(), since.toISOString(), ...channelIds);
    }
    if (listIds.length) {
      queries.push(`${listRows} AND received_at >= ? AND list_id IN (${listIds.map(() => '?').join(',')})
        AND json_extract(payload, '$.status') IN ('RECORDED', 'BLOCKED')`);
      params.push(workspaceId, now.toISOString(), targetUserId, since.toISOString(), ...listIds);
    }
    if (!queries.length) return;
    const sql = `SELECT * FROM (${queries.join(' UNION ALL ')}) ORDER BY received_at, message_ts, channel_id`;
    for (const row of this.database.prepare(sql).iterate(...params)) yield readRecord(row)!;
  }
  find(workspaceId: string, channelId: string, messageTs: string, now: Date): SlackAnalysisSourceItem | null {
    if (workspaceId !== this.config.workspaceId) return null;
    this.assertIdentity();
    if (this.config.listAnalysisEnabled && getSlackListIds(this.config).includes(channelId)) {
      const rows = this.database.prepare(`${listRows} AND list_id = ? AND message_ts = ? LIMIT 2`)
        .all(workspaceId, now.toISOString(), this.config.targetUserId, channelId, messageTs);
      return rows.length === 1 ? readRecord(rows[0]) : null;
    }
    if (!this.config.channelIds.includes(channelId)) return null;
    return readRecord(this.database.prepare(`${channelRows} AND r.channel_id = ? AND r.message_ts = ?`)
      .get(workspaceId, now.toISOString(), channelId, messageTs));
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
