import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import { invalidateTaskRequest } from '../domain/state.js';
import { getSlackListIds } from '../domain/slack.js';
import type {
  SlackCollectedRequest, SlackConnectionState, SlackInbox, SlackInboxItem,
  SlackListAnalysisThread, SlackMessageChange, SlackReceiverConfig, SlackThreadSnapshot,
} from '../domain/slack.js';
import type { Task } from '../domain/types.js';
import type { ApprovalRecord } from '../domain/approval.js';
import { containsSensitiveText, redactSlackText } from '../policy/redaction.js';
import { assertRuntimeFile } from '../policy/runtime-path.js';
import type { SlackListComment, SlackListThread } from '../policy/slack-list-export.js';
import { compareSlackTimestamps, isSlackTimestamp, slackTimestampTicks } from '../policy/slack-timestamp.js';
import { SqliteSlackListAnalysis, type ListScope } from './sqlite-slack-list-analysis.js';

export interface SlackListMention {
  listId: string;
  itemId: string;
  commentId: string;
  text: string;
  detectedAt: string;
}

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const interruptedCode = 'INTERRUPTED_REVIEW_REQUIRED';
const isId = (value: unknown): value is string => typeof value === 'string'
  && idPattern.test(value) && !containsSensitiveText(value);

const observedTimestamp = (milliseconds: number): string =>
  `${Math.floor(milliseconds / 1000)}.${String(milliseconds % 1000).padStart(3, '0')}000`;

const parsePayload = <T>(payload: unknown): T => {
  if (typeof payload !== 'string' || payload.length > 1_000_000) throw new HarnessError('INVALID_SLACK_STORAGE');
  // 런타임 DB는 같은 OS 사용자의 비공개 자료이며 외부 입력을 직접 보관하지 않는다.
  return JSON.parse(payload) as T;
};

export class SqliteSlackInbox implements SlackInbox {
  private readonly database: DatabaseSync;
  private readonly config: SlackReceiverConfig & { listIds: string[] };
  private readonly listAnalysis: SqliteSlackListAnalysis;

  constructor(filePath: string, config: SlackReceiverConfig) {
    if (!Number.isSafeInteger(config.maxPending) || config.maxPending < 1
      || !Number.isSafeInteger(config.retentionHours) || config.retentionHours < 1
      || config.retentionHours > 8_760
      || ![config.thread.maxMessages, config.thread.maxPages, config.thread.maxBytes]
        .every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new HarnessError('INVALID_SLACK_CONFIG');
    }
    this.config = {
      ...config, channelIds: [...config.channelIds], listIds: [...getSlackListIds(config)], thread: { ...config.thread },
    };
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
      CREATE TABLE IF NOT EXISTS slack_list_snapshots (
        workspace_id TEXT NOT NULL, list_id TEXT NOT NULL, target_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, list_id, target_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS slack_list_comments (
        workspace_id TEXT NOT NULL, list_id TEXT NOT NULL, target_id TEXT NOT NULL,
        item_id TEXT NOT NULL, comment_id TEXT NOT NULL,
        text TEXT, detected_at INTEGER, expires_at INTEGER,
        pending_export INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(workspace_id, list_id, target_id, item_id, comment_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS slack_list_threads (
        workspace_id TEXT NOT NULL, list_id TEXT NOT NULL, target_id TEXT NOT NULL,
        item_id TEXT NOT NULL, thread_ts TEXT NOT NULL, last_reply_ts TEXT NOT NULL,
        PRIMARY KEY(workspace_id, list_id, target_id, item_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS slack_list_mentions_expiry ON slack_list_comments(expires_at)
        WHERE text IS NOT NULL;
      CREATE INDEX IF NOT EXISTS slack_list_mentions_scope ON slack_list_comments(workspace_id, list_id, target_id, detected_at DESC)
        WHERE text IS NOT NULL;
    `);
    this.listAnalysis = new SqliteSlackListAnalysis(this.database);
    const hasExportFlag = (): boolean => this.database.prepare('PRAGMA table_info(slack_list_comments)').all()
      .some(column => column.name === 'pending_export');
    if (!hasExportFlag()) this.transaction(() => {
      // 조회 CLI와 수신기가 이전 스키마를 동시에 열더라도 열은 한 번만 추가한다.
      if (!hasExportFlag()) this.database.exec('ALTER TABLE slack_list_comments ADD COLUMN pending_export INTEGER NOT NULL DEFAULT 0');
    });
  }

  /** 내보내기의 기준점, 항목/스레드 연결, 댓글 중복 키는 함께 커밋한다. */
  applyListSnapshot(listId: string, comments: readonly SlackListComment[], now: number, threads: readonly SlackListThread[] = [],
    captureAnalysis = false):
    { baseline: boolean; mentions: SlackListMention[] } {
    const scope = this.listScope(listId);
    return this.transaction(() => {
      const previous = this.database.prepare(`
        SELECT observed_at FROM slack_list_snapshots WHERE workspace_id = ? AND list_id = ? AND target_id = ?
      `).get(...scope);
      if (previous && Number(previous.observed_at) > now) return { baseline: false, mentions: [] };
      // 이 스냅샷에 더 최신 답글이 있어도 그 중간의 누락을 찾도록 기존 댓글 기준을 먼저 고정한다.
      this.syncListThreads(scope, threads, previous ? Number(previous.observed_at) : null, now);
      this.database.prepare(`
        INSERT INTO slack_list_snapshots(workspace_id, list_id, target_id, observed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id, list_id, target_id) DO UPDATE SET observed_at = excluded.observed_at
      `).run(...scope, now);
      return { baseline: !previous, mentions: this.saveListComments(scope, comments, previous ? 'export' : 'baseline', now, captureAnalysis) };
    });
  }

  getListThreadCursor(listId: string, itemId: string, threadTs: string): string | null {
    const scope = this.listScope(listId);
    const row = this.database.prepare(`
      SELECT last_reply_ts FROM slack_list_threads
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND item_id = ? AND thread_ts = ?
    `).get(...scope, itemId, threadTs);
    return row ? String(row.last_reply_ts) : null;
  }

  applyListThreadReplies(listId: string, itemId: string, threadTs: string, oldest: string,
    comments: readonly SlackListComment[], now: number, captureAnalysis = false): SlackListMention[] {
    const scope = this.listScope(listId);
    return this.transaction(() => {
      // 다른 조회가 먼저 진행됐거나 항목이 제거·교체됐다면 늦게 도착한 페이지를 버린다.
      if (this.getListThreadCursor(listId, itemId, threadTs) !== oldest) return [];
      let latest = oldest;
      for (const comment of comments) {
        if (comment.itemId !== itemId || !isSlackTimestamp(comment.commentId)
          || compareSlackTimestamps(comment.commentId, latest) <= 0) throw new HarnessError('SLACK_LIST_COMMENT_INVALID');
        latest = comment.commentId;
      }
      if (latest === oldest) return [];
      this.listAnalysis.invalidateUnseenReplies(scope, itemId, threadTs, comments.map(comment => comment.commentId), now);
      const mentions = this.saveListComments(scope, comments, 'direct', now, captureAnalysis);
      this.database.prepare(`
        UPDATE slack_list_threads SET last_reply_ts = ?
        WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND item_id = ?
      `).run(latest, ...scope, itemId);
      return mentions;
    });
  }

  private listScope(listId: string): ListScope {
    if (!isId(listId) || !this.config.listIds.includes(listId)) throw new HarnessError('SLACK_LIST_DENIED');
    return [this.config.workspaceId, listId, this.config.targetUserId];
  }

  findListAnalysisRequest(listId: string, commentId: string, now = Date.now()): SlackCollectedRequest | null {
    return this.listAnalysis.find(this.listScope(listId), commentId, now);
  }

  listAnalysisThreads(listId: string, now: number): SlackListThread[] {
    const scope = this.listScope(listId);
    return this.config.listAnalysisEnabled ? this.listAnalysis.threads(scope, now) : [];
  }

  refreshListAnalysisThread(listId: string, itemId: string, threadTs: string, snapshot: SlackListAnalysisThread, now: number): void {
    const scope = this.listScope(listId);
    if (!this.config.listAnalysisEnabled) return;
    this.transaction(() => this.listAnalysis.refresh(scope, itemId, threadTs,
      { ...snapshot, thread: this.safeThread(snapshot.thread)! }, now));
  }

  invalidateListAnalysis(listId: string, reason: string, now: number, itemId?: string): void {
    this.listAnalysis.invalidate(this.listScope(listId), redactSlackText(reason).slice(0, 128), now, itemId);
  }

  recoverListAnalysis(listId: string, now: number): void {
    this.listAnalysis.invalidate(this.listScope(listId), interruptedCode, now, undefined, undefined, true);
  }

  private syncListThreads(scope: ListScope, threads: readonly SlackListThread[], previous: number | null, now: number): void {
    const registered = this.database.prepare(`
      SELECT item_id, thread_ts FROM slack_list_threads WHERE workspace_id = ? AND list_id = ? AND target_id = ?
    `).all(...scope);
    const old = new Map(registered.map(row => [String(row.item_id), String(row.thread_ts)]));
    const seenItems = new Set<string>();
    const seenThreads = new Set<bigint>();
    const clearDirectBodies = this.database.prepare(`
      UPDATE slack_list_comments SET text = NULL, pending_export = 0
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND item_id = ? AND pending_export = 1
    `);
    const history = this.database.prepare(`
      SELECT comment_id FROM slack_list_comments WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND item_id = ?
    `);
    const bind = this.database.prepare(`
      INSERT INTO slack_list_threads(workspace_id, list_id, target_id, item_id, thread_ts, last_reply_ts) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, list_id, target_id, item_id) DO UPDATE SET thread_ts = excluded.thread_ts, last_reply_ts = excluded.last_reply_ts
    `);
    for (const { itemId, threadTs } of threads) {
      if (!isId(itemId) || !isSlackTimestamp(threadTs)) throw new HarnessError('SLACK_LIST_THREAD_INVALID');
      const threadTime = slackTimestampTicks(threadTs);
      if (seenItems.has(itemId) || seenThreads.has(threadTime)) throw new HarnessError('SLACK_LIST_THREAD_INVALID');
      seenItems.add(itemId);
      seenThreads.add(threadTime);
      const oldThread = old.get(itemId);
      old.delete(itemId);
      if (oldThread === threadTs) continue;
      if (oldThread !== undefined) {
        clearDirectBodies.run(...scope, itemId);
        this.listAnalysis.invalidate(scope, 'SLACK_LIST_THREAD_REBOUND', now, itemId);
      }
      let saved: string | null = null;
      if (previous !== null && oldThread === undefined) {
        // 기존 설치에는 스레드 테이블이 없어 항목별로 이미 저장한 마지막 Slack 댓글 시각을 복원한다.
        for (const row of history.iterate(...scope, itemId)) {
          const ts = row.comment_id;
          if (isSlackTimestamp(ts) && (saved === null || compareSlackTimestamps(ts, saved) > 0)) saved = ts;
        }
      }
      const oldest = saved ?? observedTimestamp(previous ?? now);
      bind.run(...scope, itemId, threadTs, compareSlackTimestamps(threadTs, oldest) > 0 ? threadTs : oldest);
    }
    const remove = this.database.prepare(`
      DELETE FROM slack_list_threads WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND item_id = ?
    `);
    for (const itemId of old.keys()) {
      clearDirectBodies.run(...scope, itemId);
      this.listAnalysis.invalidate(scope, 'SLACK_LIST_THREAD_REMOVED', now, itemId);
      remove.run(...scope, itemId);
    }
  }

  private saveListComments(scope: ListScope, comments: readonly SlackListComment[], source: 'baseline' | 'export' | 'direct',
    now: number, captureAnalysis: boolean): SlackListMention[] {
    const detectedAt = new Date(now).toISOString();
    const expiresAt = now + this.config.retentionHours * 3_600_000;
    this.pruneListMentions(now);
    const activeRows = source === 'direct' ? [] : this.database.prepare(`
      SELECT rowid, item_id, comment_id, text, pending_export FROM slack_list_comments
      WHERE workspace_id = ? AND list_id = ? AND target_id = ? AND text IS NOT NULL
    `).all(...scope);
    const active = new Map(activeRows.map(row => [`${row.item_id}/${row.comment_id}`, row]));
    const update = this.database.prepare('UPDATE slack_list_comments SET text = ?, pending_export = 0 WHERE rowid = ?');
    const insert = this.database.prepare(`
      INSERT INTO slack_list_comments(workspace_id, list_id, target_id, item_id, comment_id, text, detected_at, expires_at, pending_export)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `);
    const mentions: SlackListMention[] = [];
    for (const comment of comments) {
      if (!isId(comment.itemId) || !(isId(comment.commentId) || isSlackTimestamp(comment.commentId))
        || typeof comment.mentionsTarget !== 'boolean' || typeof comment.text !== 'string'
        || Buffer.byteLength(comment.text) > 16_384) throw new HarnessError('SLACK_LIST_COMMENT_INVALID');
      const key = `${comment.itemId}/${comment.commentId}`;
      const current = active.get(key);
      const text = source !== 'baseline' && comment.mentionsTarget ? redactSlackText(comment.text) : null;
      if (current) {
        // 내보내기와 직접 조회의 발췌 표기는 달라질 수 있다. 본문 편집은 전체 스레드 재조회에서 비교한다.
        if (text === null) this.listAnalysis.invalidate(scope, 'REQUEST_MENTION_REMOVED', now, comment.itemId, comment.commentId);
        if (current.text !== text || current.pending_export !== 0) update.run(text, current.rowid!);
        active.delete(key);
        continue;
      }
      const inserted = insert.run(...scope, comment.itemId, comment.commentId,
        text, text === null ? null : now, text === null ? null : expiresAt, Number(source === 'direct' && text !== null));
      if (text !== null && inserted.changes === 1) {
        if (captureAnalysis && this.config.listAnalysisEnabled) this.listAnalysis.register(scope, comment.itemId, comment.commentId, now, expiresAt);
        mentions.push({ listId: scope[1], itemId: comment.itemId, commentId: comment.commentId, text, detectedAt });
      }
    }
    // 직접 조회에서 먼저 확인한 본문은 내보내기가 따라잡거나 보관 기한이 끝날 때까지 유지한다.
    for (const row of active.values()) {
      if (row.pending_export !== 0) continue;
      update.run(null, row.rowid!);
      this.listAnalysis.invalidate(scope, 'SLACK_LIST_COMMENT_REMOVED', now, String(row.item_id), String(row.comment_id));
    }
    return mentions;
  }

  listMentions(now = Date.now()): SlackListMention[] {
    const { workspaceId, listIds, targetUserId } = this.config;
    if (listIds.length === 0) return [];
    this.pruneListMentions(now);
    const placeholders = listIds.map(() => '?').join(', ');
    return this.database.prepare(`
      SELECT list_id, item_id, comment_id, text, detected_at FROM slack_list_comments
      WHERE workspace_id = ? AND target_id = ? AND list_id IN (${placeholders}) AND text IS NOT NULL AND expires_at > ?
      ORDER BY detected_at DESC, rowid DESC LIMIT 100
    `).all(workspaceId, targetUserId, ...listIds, now).map(row => ({
      listId: String(row.list_id), itemId: String(row.item_id), commentId: String(row.comment_id),
      text: String(row.text), detectedAt: new Date(Number(row.detected_at)).toISOString(),
    }));
  }

  private pruneListMentions(now: number): number {
    return Number(this.database.prepare(`
      UPDATE slack_list_comments SET text = NULL, pending_export = 0 WHERE text IS NOT NULL AND expires_at <= ?
    `).run(now).changes);
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
        || compareSlackTimestamps(event.revision, String(previous.revision)) <= 0);
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
      return Number(inbox) + Number(requests) + this.pruneListMentions(now.getTime()) + this.listAnalysis.prune(now.getTime());
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
      && [event.messageTs, event.threadTs, event.revision].every(isSlackTimestamp)
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
      if (!isSlackTimestamp(message.ts) || !isId(message.user)) {
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
        || (sameMessage && compareSlackTimestamps(task.requestRevision, event.revision) >= 0)) continue;
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
