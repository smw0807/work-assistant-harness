import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SlackCollectedRequest, SlackListAnalysisThread, SlackReceiverConfig } from '../domain/slack.js';
import { isSlackTimestamp } from '../policy/slack-timestamp.js';
import { slackRequestMetadata, slackThreadHash, slackThreadTimestamps } from './slack-source-metadata.js';

export type ListScope = readonly [workspaceId: string, listId: string, targetUserId: string];

/** 수신함의 트랜잭션에 참여해 새 멘션과 분석 요청을 함께 기록한다. */
export class SqliteSlackListAnalysis {
  constructor(private readonly database: DatabaseSync, private readonly config: SlackReceiverConfig, private readonly sessionId: string) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS slack_list_analysis_requests (
        workspace_id TEXT NOT NULL, list_id TEXT NOT NULL, target_id TEXT NOT NULL,
        item_id TEXT NOT NULL, message_ts TEXT NOT NULL, thread_ts TEXT NOT NULL,
        received_at TEXT NOT NULL, expires_at TEXT NOT NULL, payload TEXT,
        PRIMARY KEY(workspace_id, list_id, target_id, item_id, message_ts)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS slack_list_analysis_retention ON slack_list_analysis_requests(expires_at);
    `);
  }

  register(scope: ListScope, itemId: string, messageTs: string, now: number, expires: number): void {
    if (!isSlackTimestamp(messageTs)) return;
    const binding = this.database.prepare(`SELECT thread_ts FROM slack_list_threads
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND item_id = ?`).get(...scope, itemId);
    const nowIso = new Date(now).toISOString();
    const request: SlackCollectedRequest = {
      workspaceId: scope[0], channelId: scope[1], listItemId: itemId, messageTs,
      threadTs: binding ? String(binding.thread_ts) : messageTs,
      requesterId: 'unknown', revision: messageTs,
      eventId: createHash('sha256').update(JSON.stringify([...scope, itemId, messageTs])).digest('hex'),
      status: binding ? 'RECEIVED' : 'BLOCKED', failureCode: binding ? null : 'SLACK_LIST_THREAD_UNBOUND',
      text: '', thread: null, updatedAt: nowIso,
    };
    this.database.prepare(`INSERT INTO slack_list_analysis_requests
      (workspace_id, list_id, target_id, item_id, message_ts, thread_ts, received_at, expires_at, payload, receiver_session)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(...scope, itemId, messageTs, request.threadTs, nowIso, new Date(expires).toISOString(), JSON.stringify(request), binding ? this.sessionId : null);
  }

  find(scope: ListScope, messageTs: string, now: number): SlackCollectedRequest | null {
    const rows = this.database.prepare(`SELECT payload FROM slack_list_analysis_requests
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND message_ts = ? AND expires_at > ?
      AND payload IS NOT NULL LIMIT 2`).all(...scope, messageTs, new Date(now).toISOString());
    return rows.length === 1 ? JSON.parse(String(rows[0]!.payload)) as SlackCollectedRequest : null;
  }

  threads(scope: ListScope, now: number): { itemId: string; threadTs: string }[] {
    return this.database.prepare(`SELECT DISTINCT item_id, thread_ts FROM slack_list_analysis_requests
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND expires_at > ?
      AND json_extract(payload, '$.status') IN ('RECEIVED','RECORDED')`)
      .all(...scope, new Date(now).toISOString()).map(row => ({ itemId: String(row.item_id), threadTs: String(row.thread_ts) }));
  }

  invalidateUnseenReplies(scope: ListScope, itemId: string, threadTs: string, replyTimestamps: readonly string[], now: number): void {
    const rows = this.database.prepare(`SELECT message_ts, thread_timestamps
      FROM slack_list_analysis_requests WHERE workspace_id = ? AND list_id = ? AND target_id = ?
      AND item_id = ? AND thread_ts = ? AND expires_at > ? AND json_extract(payload, '$.status') = 'RECORDED'`)
      .all(...scope, itemId, threadTs, new Date(now).toISOString());
    for (const row of rows) {
      const known = new Set(JSON.parse(String(row.thread_timestamps ?? '[]')) as string[]);
      if (replyTimestamps.some(ts => !known.has(ts))) {
        this.invalidate(scope, 'SLACK_LIST_THREAD_CHANGED', now, itemId, String(row.message_ts));
      }
    }
  }

  refresh(scope: ListScope, itemId: string, threadTs: string, snapshot: SlackListAnalysisThread, now: number): SlackCollectedRequest[] {
    const rows = this.database.prepare(`SELECT rowid, payload, thread_hash, receiver_session FROM slack_list_analysis_requests
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND item_id = ? AND thread_ts = ? AND expires_at > ?
      AND json_extract(payload, '$.status') IN ('RECEIVED','RECORDED')`).all(...scope, itemId, threadTs, new Date(now).toISOString());
    const { thread, mentionTs } = snapshot;
    const mentions = new Set(mentionTs);
    const messages = new Map(thread.messages.map(message => [message.ts, message]));
    const digest = slackThreadHash(thread);
    const timestamps = slackThreadTimestamps(thread);
    const update = this.database.prepare(`UPDATE slack_list_analysis_requests
      SET payload = ?, thread_hash = ?, thread_timestamps = ?, receiver_session = NULL WHERE rowid = ?`);
    const eligible: SlackCollectedRequest[] = [];
    for (const row of rows) {
      const request = JSON.parse(String(row.payload)) as SlackCollectedRequest;
      const message = messages.get(request.messageTs);
      let reason: string | null = null;
      if (!thread.complete || thread.reason !== null) reason = thread.reason ?? 'SLACK_ANALYSIS_INCOMPLETE_THREAD';
      else if (thread.messages[0]?.ts !== threadTs) reason = 'SLACK_LIST_THREAD_MISMATCH';
      else if (!mentions.has(request.messageTs) || !message || message.user === scope[2]) reason = 'REQUEST_MENTION_REMOVED';
      else if (request.status === 'RECORDED') {
        if (row.thread_hash === digest) continue;
        reason = 'SLACK_LIST_THREAD_CHANGED';
      }
      if (reason || !message) {
        request.status = request.status === 'RECORDED' ? 'INVALIDATED' : 'BLOCKED';
        request.failureCode = reason;
        request.text = '';
        request.thread = null;
      } else {
        request.status = 'RECORDED';
        request.requesterId = message.user;
        request.text = message.text;
        request.thread = thread;
      }
      request.updatedAt = new Date(now).toISOString();
      const metadata = slackRequestMetadata(request, this.config);
      update.run(JSON.stringify(metadata), request.thread ? digest : null, request.thread ? timestamps : null, row.rowid!);
      if (metadata.sourceHash && row.receiver_session === this.sessionId) eligible.push(request);
    }
    return eligible;
  }

  invalidate(scope: ListScope, reason: string, now: number, itemId?: string, messageTs?: string, pendingOnly = false): void {
    this.database.prepare(`UPDATE slack_list_analysis_requests SET thread_hash = NULL, thread_timestamps = NULL, receiver_session = NULL,
      payload = json_set(json_remove(payload, '$.sourceHash', '$.legacySourceHash', '$.receiverHash', '$.messageCount'),
      '$.status', CASE WHEN json_extract(payload, '$.status') = 'RECEIVED' THEN 'BLOCKED' ELSE 'INVALIDATED' END,
      '$.failureCode', ?, '$.thread', NULL, '$.text', '', '$.updatedAt', ?)
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND (? IS NULL OR item_id = ?)
      AND (? IS NULL OR message_ts = ?) AND json_extract(payload, '$.status') IN ('RECEIVED', ?)`)
      .run(reason, new Date(now).toISOString(), ...scope, itemId ?? null, itemId ?? null, messageTs ?? null, messageTs ?? null,
        pendingOnly ? 'RECEIVED' : 'RECORDED');
  }

  blockDelivery(scope: ListScope, request: SlackCollectedRequest): void {
    this.database.prepare(`UPDATE slack_list_analysis_requests SET thread_hash = NULL, thread_timestamps = NULL,
      payload = json_set(json_remove(payload, '$.sourceHash', '$.receiverHash', '$.messageCount'), '$.status', 'BLOCKED',
        '$.failureCode', 'SLACK_ANALYSIS_QUEUE_FULL', '$.thread', NULL)
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND item_id = ? AND message_ts = ?
      AND json_extract(payload, '$.eventId') = ? AND json_extract(payload, '$.revision') = ?
      AND json_extract(payload, '$.status') = 'RECORDED'`)
      .run(...scope, request.listItemId!, request.messageTs, request.eventId, request.revision);
  }

  prune(now: number): number {
    // 중복 판별 키는 slack_list_comments에 남으므로 만료된 분석 문맥은 행 전체를 삭제할 수 있다.
    return Number(this.database.prepare('DELETE FROM slack_list_analysis_requests WHERE expires_at <= ?')
      .run(new Date(now).toISOString()).changes);
  }
}
