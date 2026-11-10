import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import { invalidateTaskRequest } from '../domain/state.js';
import type {
  SlackCollectedRequest, SlackConnectionState, SlackInbox, SlackInboxItem,
  SlackMessageChange, SlackReceiverConfig, SlackThreadSnapshot,
} from '../domain/slack.js';
import type { Task } from '../domain/types.js';
import type { ApprovalRecord } from '../domain/approval.js';
import { containsSensitiveText, redactSlackText } from '../policy/redaction.js';
import { assertRuntimeFile } from '../policy/runtime-path.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const timestampPattern = /^\d{1,20}\.\d{1,10}$/;
const interruptedCode = 'INTERRUPTED_REVIEW_REQUIRED';
const isId = (value: unknown): value is string => typeof value === 'string'
  && idPattern.test(value) && !containsSensitiveText(value);
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && timestampPattern.test(value);

const compareRevisions = (left: string, right: string): number => {
  const toTimestamp = (value: string): bigint => {
    if (!timestampPattern.test(value)) throw new HarnessError('INVALID_SLACK_REVISION');
    const [seconds = '', fraction = ''] = value.split('.');
    return BigInt(seconds) * 10_000_000_000n + BigInt(fraction.padEnd(10, '0'));
  };
  const difference = toTimestamp(left) - toTimestamp(right);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
};

const parsePayload = <T>(payload: unknown): T => {
  if (typeof payload !== 'string' || payload.length > 1_000_000) throw new HarnessError('INVALID_SLACK_STORAGE');
  // 런타임 DB는 같은 OS 사용자의 비공개 자료이며 외부 입력을 직접 보관하지 않는다.
  return JSON.parse(payload) as T;
};

export class SqliteSlackInbox implements SlackInbox {
  private readonly database: DatabaseSync;
  private readonly config: SlackReceiverConfig;

  constructor(filePath: string, config: SlackReceiverConfig) {
    if (!Number.isSafeInteger(config.maxPending) || config.maxPending < 1
      || !Number.isSafeInteger(config.retentionHours) || config.retentionHours < 1
      || config.retentionHours > 8_760
      || ![config.thread.maxMessages, config.thread.maxPages, config.thread.maxBytes]
        .every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new HarnessError('INVALID_SLACK_CONFIG');
    }
    this.config = { ...config, channelIds: [...config.channelIds], thread: { ...config.thread } };
    for (const suffix of ['', '-journal', '-wal', '-shm']) assertRuntimeFile(`${filePath}${suffix}`);
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    chmodSync(filePath, 0o600);
    this.database.exec(`
      PRAGMA busy_timeout = 500;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS slack_inbox (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT,
        received_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        failure_code TEXT,
        PRIMARY KEY(workspace_id, event_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS slack_requests (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        revision TEXT NOT NULL,
        deleted INTEGER NOT NULL,
        payload TEXT,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, channel_id, message_ts)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS slack_connection (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS slack_connection_history (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
    `);
  }

  receive(input: SlackMessageChange, now: Date): 'accepted' | 'duplicate' | 'ignored' {
    if (!this.isAllowed(input)) return 'ignored';
    const event = { ...input, text: input.kind === 'deleted' ? '' : redactSlackText(input.text) };
    return this.transaction(() => {
      if (this.database.prepare('SELECT 1 FROM slack_inbox WHERE workspace_id = ? AND event_id = ?')
        .get(event.workspaceId, event.eventId)) return 'duplicate';
      const previous = this.database.prepare(`
        SELECT revision, deleted, payload FROM slack_requests
        WHERE workspace_id = ? AND channel_id = ? AND message_ts = ?
      `).get(event.workspaceId, event.channelId, event.messageTs);
      const request = previous?.payload ? parsePayload<SlackCollectedRequest>(previous.payload) : null;
      const stale = previous && (previous.deleted === 1
        || compareRevisions(event.revision, String(previous.revision)) <= 0);
      if (stale || (event.kind === 'created' && !event.mentionsTarget)) {
        this.insertInbox(event, null, now);
        return 'ignored';
      }

      const tracked = request !== null;
      const accepted = tracked || (event.kind !== 'deleted' && event.mentionsTarget);
      let needsCollection = accepted && event.kind !== 'deleted' && event.mentionsTarget;
      let queueFull = false;
      // 본문 제거와 무효화는 후속 수집이 없으므로 포화된 조사 큐 때문에 거부하지 않는다.
      if (needsCollection && this.queueIsFull(event)) {
        if (event.kind === 'created') throw new HarnessError('SLACK_INBOX_FULL');
        // 편집을 되돌릴 수 없으므로 기존 계획을 먼저 무효화하고 새 문맥 수집만 차단한다.
        needsCollection = false;
        queueFull = true;
      }
      if (event.kind !== 'created') {
        const knownThread = request !== null || event.threadTs !== event.messageTs;
        const affectedThreads = this.invalidateThreadContexts(event, request?.threadTs ?? event.threadTs, knownThread, now);
        this.invalidateTasks(event, affectedThreads, now);
      }
      this.database.prepare(`
        UPDATE slack_inbox SET payload = NULL, state = 'done'
        WHERE workspace_id = ? AND channel_id = ? AND message_ts = ?
      `).run(event.workspaceId, event.channelId, event.messageTs);

      const collected: SlackCollectedRequest | null = accepted ? {
        workspaceId: event.workspaceId, channelId: event.channelId, messageTs: event.messageTs,
        threadTs: request?.threadTs ?? event.threadTs,
        requesterId: request?.requesterId ?? event.requesterId,
        revision: event.revision, eventId: event.eventId,
        status: event.kind === 'deleted' || !event.mentionsTarget ? 'INVALIDATED' : queueFull ? 'BLOCKED' : 'RECEIVED',
        text: event.kind === 'deleted' || !event.mentionsTarget ? '' : event.text,
        thread: null, updatedAt: now.toISOString(),
        failureCode: queueFull ? 'SLACK_INBOX_FULL' : event.kind === 'deleted' ? 'REQUEST_DELETED'
          : !event.mentionsTarget ? 'REQUEST_MENTION_REMOVED' : null,
      } : null;
      this.database.prepare(`
        INSERT INTO slack_requests(workspace_id, channel_id, message_ts, revision, deleted, payload, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, channel_id, message_ts) DO UPDATE SET
          revision = excluded.revision, deleted = excluded.deleted,
          payload = excluded.payload, expires_at = excluded.expires_at
      `).run(event.workspaceId, event.channelId, event.messageTs, event.revision,
        event.kind === 'deleted' ? 1 : 0, collected ? JSON.stringify(collected) : null, this.expiresAt(now));
      this.insertInbox(event, needsCollection ? {
        ...event, text: collected?.text ?? '', threadTs: collected?.threadTs ?? event.threadTs,
      } : null, now, queueFull ? 'SLACK_INBOX_FULL' : null);
      return accepted ? 'accepted' : 'ignored';
    });
  }

  pending(): SlackInboxItem[] {
    return this.database.prepare(`
      SELECT payload, state, received_at, expires_at, failure_code FROM slack_inbox
      WHERE state = 'pending' AND payload IS NOT NULL ORDER BY rowid
    `).all().map((row) => ({
      event: parsePayload<SlackMessageChange>(row.payload), state: 'pending',
      receivedAt: String(row.received_at), expiresAt: String(row.expires_at),
      failureCode: row.failure_code === null ? null : String(row.failure_code),
    }));
  }

  claim(eventId: string, workspaceId: string): boolean {
    return this.database.prepare(`
      UPDATE slack_inbox SET state = 'processing'
      WHERE workspace_id = ? AND event_id = ? AND state = 'pending' AND payload IS NOT NULL
    `).run(workspaceId, eventId).changes === 1;
  }

  complete(event: SlackMessageChange, thread: SlackThreadSnapshot | null, now: Date): void {
    this.finish(event, 'done', null, now, thread);
  }

  block(event: SlackMessageChange, failureCode: string, now: Date): void {
    this.finish(event, 'blocked', redactSlackText(failureCode).slice(0, 128), now, null);
  }

  recoverInterrupted(now: Date): number {
    return this.transaction(() => {
      const interrupted = this.database.prepare(`
        SELECT payload FROM slack_inbox WHERE state = 'processing' AND payload IS NOT NULL
      `).all();
      for (const row of interrupted) {
        const event = parsePayload<SlackMessageChange>(row.payload);
        this.updateRequest(event, (request) => request.status === 'RECEIVED'
          ? { ...request, status: 'BLOCKED', thread: null, updatedAt: now.toISOString(), failureCode: interruptedCode }
          : request);
      }
      return Number(this.database.prepare(`
        UPDATE slack_inbox SET state = 'blocked', failure_code = ? WHERE state = 'processing'
      `).run(interruptedCode).changes);
    });
  }

  list(): SlackCollectedRequest[] {
    return this.database.prepare('SELECT payload FROM slack_requests WHERE payload IS NOT NULL ORDER BY rowid')
      .all().map((row) => parsePayload<SlackCollectedRequest>(row.payload));
  }

  find(workspaceId: string, channelId: string, messageTs: string): SlackCollectedRequest | null {
    const row = this.database.prepare(`
      SELECT payload FROM slack_requests WHERE workspace_id = ? AND channel_id = ? AND message_ts = ?
    `).get(workspaceId, channelId, messageTs);
    return row?.payload ? parsePayload<SlackCollectedRequest>(row.payload) : null;
  }

  setConnection(state: SlackConnectionState): void {
    const payload = JSON.stringify({ ...state, reason: redactSlackText(state.reason).slice(0, 512) });
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO slack_connection(singleton, payload) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload
      `).run(payload);
      this.database.prepare('INSERT INTO slack_connection_history(payload) VALUES (?)').run(payload);
      this.database.exec(`
        DELETE FROM slack_connection_history
        WHERE id NOT IN (SELECT id FROM slack_connection_history ORDER BY id DESC LIMIT 100)
      `);
    });
  }

  connection(): SlackConnectionState | null {
    const row = this.database.prepare('SELECT payload FROM slack_connection WHERE singleton = 1').get();
    return row ? parsePayload<SlackConnectionState>(row.payload) : null;
  }

  connectionHistory(): SlackConnectionState[] {
    return this.database.prepare('SELECT payload FROM slack_connection_history ORDER BY id')
      .all().map((row) => parsePayload<SlackConnectionState>(row.payload));
  }

  prune(now: Date): number {
    return this.transaction(() => {
      const inbox = this.database.prepare(`
        UPDATE slack_inbox SET payload = NULL, state = 'done'
        WHERE payload IS NOT NULL AND expires_at <= ?
      `).run(now.toISOString()).changes;
      const requests = this.database.prepare(`
        UPDATE slack_requests SET payload = NULL WHERE payload IS NOT NULL AND expires_at <= ?
      `).run(now.toISOString()).changes;
      // 본문은 보관 기간 후 지우고, event 중복 키와 revision/삭제 marker는 DB 수명 동안 유지한다.
      // 이 최소 marker를 지우면 오래된 Slack 재전달을 새 요청으로 받아들일 수 있다.
      return Number(inbox) + Number(requests);
    });
  }

  close(): void {
    this.database.close();
  }

  private isAllowed(event: SlackMessageChange): boolean {
    return event.workspaceId === this.config.workspaceId && this.config.channelIds.includes(event.channelId)
      && [event.workspaceId, event.channelId, event.eventId].every(isId)
      && (event.kind === 'deleted' ? event.requesterId === '' || isId(event.requesterId)
        : isId(event.requesterId) && event.requesterId !== this.config.targetUserId)
      && ['created', 'edited', 'deleted'].includes(event.kind)
      && [event.messageTs, event.threadTs, event.revision].every(isTimestamp)
      && typeof event.mentionsTarget === 'boolean'
      && typeof event.text === 'string' && Buffer.byteLength(event.text, 'utf8') <= 16_384;
  }

  private expiresAt(now: Date): string {
    return new Date(now.getTime() + this.config.retentionHours * 3_600_000).toISOString();
  }

  private insertInbox(
    event: SlackMessageChange, payload: SlackMessageChange | null, now: Date, failureCode: string | null = null,
  ): void {
    this.database.prepare(`
      INSERT INTO slack_inbox(
        workspace_id, event_id, channel_id, message_ts, state, payload, received_at, expires_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.workspaceId, event.eventId, event.channelId, event.messageTs,
      payload ? 'pending' : failureCode ? 'blocked' : 'done',
      payload ? JSON.stringify(payload) : null, now.toISOString(), this.expiresAt(now), failureCode);
  }

  private queueIsFull(event: SlackMessageChange): boolean {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM slack_inbox WHERE state IN ('pending', 'processing')
      AND NOT (workspace_id = ? AND channel_id = ? AND message_ts = ?)
    `).get(event.workspaceId, event.channelId, event.messageTs);
    return Number(row?.count) >= this.config.maxPending;
  }

  private safeThread(thread: SlackThreadSnapshot | null): SlackThreadSnapshot | null {
    if (!thread) return null;
    const messages: SlackThreadSnapshot['messages'] = [];
    let bytes = 0;
    for (const message of thread.messages) {
      if (!isTimestamp(message.ts) || !isId(message.user)) {
        return { messages, complete: false, reason: 'INVALID_THREAD_MESSAGE' };
      }
      const safe = { ...message, text: redactSlackText(message.text) };
      const messageBytes = Buffer.byteLength(JSON.stringify(safe), 'utf8');
      if (messages.length >= this.config.thread.maxMessages || bytes + messageBytes > this.config.thread.maxBytes) {
        return { messages, complete: false, reason: 'THREAD_LIMIT_REACHED' };
      }
      messages.push(safe);
      bytes += messageBytes;
    }
    return { messages, complete: thread.complete, reason: thread.reason === null
      ? null : redactSlackText(thread.reason).slice(0, 512) };
  }

  private finish(
    event: SlackMessageChange, state: 'done' | 'blocked', failureCode: string | null,
    now: Date, thread: SlackThreadSnapshot | null,
  ): void {
    this.transaction(() => {
      const item = this.database.prepare(`
        SELECT expires_at FROM slack_inbox
        WHERE workspace_id = ? AND event_id = ? AND state = 'processing' AND payload IS NOT NULL
      `).get(event.workspaceId, event.eventId);
      if (!item) return;
      if (String(item.expires_at) <= now.toISOString()) {
        this.database.prepare(`
          UPDATE slack_inbox SET state = 'done', payload = NULL, failure_code = 'RETENTION_EXPIRED'
          WHERE workspace_id = ? AND event_id = ?
        `).run(event.workspaceId, event.eventId);
        this.database.prepare(`
          UPDATE slack_requests SET payload = NULL
          WHERE workspace_id = ? AND channel_id = ? AND message_ts = ? AND revision = ? AND expires_at <= ?
        `).run(event.workspaceId, event.channelId, event.messageTs, event.revision, now.toISOString());
        return;
      }
      const changed = this.database.prepare(`
        UPDATE slack_inbox SET state = ?, failure_code = ?
        WHERE workspace_id = ? AND event_id = ? AND state = 'processing' AND payload IS NOT NULL
      `).run(state, failureCode, event.workspaceId, event.eventId).changes;
      if (changed !== 1) return;
      this.updateRequest(event, (request) => request.status === 'RECEIVED' ? {
        ...request, status: state === 'done' ? 'RECORDED' : 'BLOCKED',
        thread: state === 'done' ? this.safeThread(thread) : null,
        failureCode, updatedAt: now.toISOString(),
      } : request);
    });
  }

  private invalidateThreadContexts(
    event: SlackMessageChange, threadTs: string, knownThread: boolean, now: Date,
  ): Set<string> {
    const affectedThreads = new Set([threadTs]);
    const rows = this.database.prepare(`
      SELECT payload FROM slack_requests WHERE workspace_id = ? AND channel_id = ? AND payload IS NOT NULL
    `).all(event.workspaceId, event.channelId);
    const requests = rows.map((row) => parsePayload<SlackCollectedRequest>(row.payload));
    // previous_message 없는 삭제도 snapshot에서 root를 찾은 뒤 같은 스레드의 진행 중 수집까지 막는다.
    for (const request of requests) {
      if (request.threadTs === threadTs) knownThread = true;
      if (request.thread?.messages.some((message) => message.ts === event.messageTs)) {
        affectedThreads.add(request.threadTs);
        knownThread = true;
      }
    }
    const activeRequests = new Set<string>();
    if (!knownThread) {
      const active = this.database.prepare(`
        SELECT event_id FROM slack_inbox WHERE workspace_id = ? AND channel_id = ?
        AND state IN ('pending', 'processing') AND payload IS NOT NULL
      `).all(event.workspaceId, event.channelId);
      for (const row of active) activeRequests.add(String(row.event_id));
    }
    for (const request of requests) {
      if (request.messageTs === event.messageTs) continue;
      const unknownRoot = !knownThread && request.status === 'RECEIVED' && activeRequests.has(request.eventId);
      if (!unknownRoot && (!knownThread || !affectedThreads.has(request.threadTs))) continue;
      if (unknownRoot) affectedThreads.add(request.threadTs);
      const invalidated: SlackCollectedRequest = {
        ...request, status: 'INVALIDATED', thread: null,
        failureCode: 'THREAD_CHANGED', updatedAt: now.toISOString(),
      };
      this.database.prepare(`
        UPDATE slack_requests SET payload = ? WHERE workspace_id = ? AND channel_id = ? AND message_ts = ?
      `).run(JSON.stringify(invalidated), request.workspaceId, request.channelId, request.messageTs);
      this.database.prepare(`
        UPDATE slack_inbox SET state = 'blocked', failure_code = ?
        WHERE workspace_id = ? AND channel_id = ? AND message_ts = ? AND state IN ('pending', 'processing')
      `).run(unknownRoot ? 'THREAD_CHANGED_UNKNOWN_ROOT' : 'THREAD_CHANGED',
        request.workspaceId, request.channelId, request.messageTs);
    }
    return affectedThreads;
  }

  private updateRequest(event: SlackMessageChange, update: (request: SlackCollectedRequest) => SlackCollectedRequest): void {
    const request = this.find(event.workspaceId, event.channelId, event.messageTs);
    if (!request || request.eventId !== event.eventId || request.revision !== event.revision) return;
    this.database.prepare(`
      UPDATE slack_requests SET payload = ?
      WHERE workspace_id = ? AND channel_id = ? AND message_ts = ? AND revision = ?
    `).run(JSON.stringify(update(request)), event.workspaceId, event.channelId, event.messageTs, event.revision);
  }

  private invalidateTasks(event: SlackMessageChange, affectedThreads: Set<string>, now: Date): void {
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()) return;
    const rows = this.database.prepare('SELECT task_id, payload FROM tasks WHERE workspace_id = ?')
      .all(event.workspaceId);
    for (const row of rows) {
      const task = parsePayload<Task>(row.payload);
      const sameMessage = task.messageTs !== undefined ? task.messageTs === event.messageTs
        : event.messageTs === event.threadTs && task.threadTs === event.messageTs
          && task.requestRevision === event.messageTs;
      const sameThread = affectedThreads.has(task.threadTs);
      if ((!sameMessage && !sameThread) || task.channelId !== event.channelId || task.status === 'CANCELLED'
        || (sameMessage && compareRevisions(task.requestRevision, event.revision) >= 0)) continue;
      // 편집/삭제 수신 트랜잭션에서만 완료된 계획까지 취소하는 예외다. 실행 승인을 만들지 않는다.
      const cancelled = invalidateTaskRequest(task,
        sameMessage && event.kind === 'deleted' ? 'REQUEST_DELETED' : 'REQUEST_CHANGED', now.toISOString());
      this.database.prepare('UPDATE tasks SET status = ?, payload = ? WHERE task_id = ?')
        .run(cancelled.status, JSON.stringify(cancelled), String(row.task_id));
      this.revokeTaskApprovals(task.taskId, now, cancelled.failureCode ?? 'REQUEST_CHANGED');
    }
  }

  private revokeTaskApprovals(taskId: string, now: Date, reason: string): void {
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get()) return;
    const rows = this.database.prepare('SELECT payload FROM approvals WHERE task_id = ? AND revoked_at IS NULL').all(taskId);
    for (const row of rows) {
      const approval = parsePayload<ApprovalRecord>(row.payload);
      const revoked = { ...approval, revokedAt: now.toISOString(), revocationReason: reason };
      this.database.prepare('UPDATE approvals SET revoked_at = ?, payload = ? WHERE approval_id = ? AND revoked_at IS NULL')
        .run(revoked.revokedAt, JSON.stringify(revoked), approval.approvalId);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
