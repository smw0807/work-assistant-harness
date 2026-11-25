import { matchesReportedSource, type SlackAnalysisSource, type SlackAnalysisSourceItem } from '../adapters/slack-analysis-source.js';
import { SqliteSlackAnalysisStore, type SlackAnalysisFailureCode, type SlackAnalysisRecord } from '../adapters/sqlite-slack-analysis.js';
import { getSlackListIds, type SlackCollectedRequest, type SlackConnectionState, type SlackReceiverConfig } from '../domain/slack.js';
import type { ReadonlyRelayConfig } from '../domain/readonly-relay.js';
import type { SlackAnalysisPayload, SlackAnalysisModelPort } from '../domain/slack-analysis.js';
import { SLACK_ANALYSIS_POLICY } from '../domain/slack-analysis.js';
import { HarnessError } from '../domain/errors.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { buildSlackAnalysisPayload, hashSlackAnalysisReceiver, hashSlackAnalysisSource, parseSlackAnalysisResponse } from '../policy/slack-analysis.js';

export interface SlackAnalysisNotice {
  event: 'slack-analysis'; status: string; runId: string | null;
  channelId?: string; messageTs?: string; listId?: string; itemId?: string; commentId?: string; failureCode: string | null;
}
interface ActiveAnalysis { record: SlackAnalysisRecord; payload: SlackAnalysisPayload; itemId: string | undefined; controller: AbortController; pending: Promise<void> }
const policyHash = hashReadonlyValue(canonicalReadonlyJson({ policy: SLACK_ANALYSIS_POLICY,
  maximumDailyAttempts: 20, concurrency: 1, retries: 0, source: 'current-session-mentions-and-complete-threads',
  repositoryAccess: false, messageDelivery: false }));

/** A separate consumer keeps native analysis out of the token-bearing receiver and its ACK path. */
export class SlackAnalysisService {
  private active: ActiveAnalysis | null = null;
  private readonly snapshots = new Map<string, SlackCollectedRequest>();
  private fatal: unknown = null;
  private stopped = false;
  private limitedDay: string | null = null;
  private readonly scopeHash: string;
  private readonly legacyScopeHash: string;
  constructor(private readonly source: SlackAnalysisSource, private readonly store: SqliteSlackAnalysisStore,
    private readonly receiver: SlackReceiverConfig, private readonly config: ReadonlyRelayConfig,
    private readonly model: (runId: string) => SlackAnalysisModelPort,
    private readonly startedAt: Date, private readonly notify: (notice: SlackAnalysisNotice) => void = () => {},
    private readonly now: () => Date = () => new Date()) {
    const channelReceiver = { ...receiver };
    delete channelReceiver.listAnalysisEnabled;
    this.scopeHash = hashReadonlyValue(canonicalReadonlyJson({ receiver: channelReceiver, config, policyHash }));
    this.legacyScopeHash = hashReadonlyValue(canonicalReadonlyJson({ receiver: { ...channelReceiver,
      thread: { maxMessages: 30, maxPages: 3, maxBytes: 16_384 } }, config, policyHash }));
  }

  recover(): number { return this.store.recover(this.now()); }

  /** 수신 트랜잭션 뒤에 전달된 현재 세션의 본문만 제한된 메모리 큐에 둔다. */
  acceptSnapshot(request: SlackCollectedRequest): void {
    const now = this.now();
    if (this.stopped || this.limitedDay === now.toISOString().slice(0, 10)) return;
    let hash: string;
    try { hash = hashSlackAnalysisSource(request, this.receiver); } catch { return; }
    if (this.snapshots.has(hash) || this.active?.payload.sourceHash === hash) return;
    const { workspaceId, channelId, messageTs, revision } = request;
    const current = this.source.find(workspaceId, channelId, messageTs, now);
    if (!current || !this.isCurrentSnapshot(current, request, hash, request.listItemId, request.thread?.messages.length)) return;
    if (this.limitedDay !== null && current.receivedAt.slice(0, 10) <= this.limitedDay) return;
    if (this.store.hasAttempt({ workspaceId, channelId, messageTs, revision }, now)) return;
    if (this.snapshots.size >= this.receiver.maxPending) {
      this.start(current, null, now, 'SLACK_ANALYSIS_QUEUE_FULL');
      return;
    }
    this.snapshots.set(hash, structuredClone(request));
  }

  private isCurrentSnapshot(item: SlackAnalysisSourceItem | null, request: Pick<SlackCollectedRequest,
    'revision' | 'eventId' | 'updatedAt' | 'threadTs' | 'requesterId'>, hash: string, itemId: string | undefined,
    messageCount: number | undefined): boolean {
    if (!item || item.receivedAt < this.startedAt.toISOString()) return false;
    const metadata = item.request;
    return metadata.status === 'RECORDED' && metadata.failureCode === null && metadata.sourceHash === hash
      && metadata.thread?.complete === true && metadata.thread.reason === null
      && metadata.receiverHash === hashSlackAnalysisReceiver(this.receiver, itemId)
      && metadata.revision === request.revision && metadata.eventId === request.eventId && metadata.updatedAt === request.updatedAt
      && metadata.threadTs === request.threadTs && metadata.requesterId === request.requesterId && metadata.listItemId === itemId
      && messageCount !== undefined && metadata.messageCount === messageCount;
  }

  tick(): void {
    if (this.fatal) throw this.fatal;
    if (this.stopped) return;
    const now = this.now(); this.store.prune(now);
    this.invalidateChangedReports(now);
    const connection = this.receiver.channelIds.length ? this.source.connection() : null;
    for (const [hash, request] of this.snapshots) {
      const item = this.source.find(request.workspaceId, request.channelId, request.messageTs, now);
      const outdated = !request.listItemId && connection !== null && request.updatedAt < connection.at;
      if (outdated || !this.isCurrentSnapshot(item, request, hash, request.listItemId, request.thread?.messages.length)) {
        this.snapshots.delete(hash);
      }
    }
    if (this.active) {
      if (!this.active.controller.signal.aborted) {
        try { this.assertCurrent(this.active.record, this.active.payload); }
        catch {
          this.active.controller.abort();
          this.notice(this.store.invalidate(this.active.record.runId, now), this.active.itemId);
        }
      }
      return;
    }
    if (this.limitedDay === now.toISOString().slice(0, 10)) return;
    for (const item of this.source.list(now, this.startedAt)) {
      // 리스트 스냅샷은 독립적인 HTTP 조회 결과이므로 채널 소켓 재연결과 무관하다.
      const itemId = item.request.listItemId;
      if (itemId === undefined && !this.hasCurrentSocket(connection, item.request.updatedAt)) continue;
      const hash = item.request.sourceHash;
      const request = hash ? this.snapshots.get(hash) : undefined;
      // DB commit이 IPC 전달보다 앞선다. 완전한 스냅샷의 본문이 아직 도착하지 않았으면 다음 tick에서 확인한다.
      if (hash && !request && item.request.status === 'RECORDED') continue;
      let payload: SlackAnalysisPayload | null = null;
      if (request && hash) {
        this.snapshots.delete(hash);
        try { payload = buildSlackAnalysisPayload(request, this.receiver, this.config); } catch { /* 예산을 초과한 본문도 차단 상태만 저장한다. */ }
      }
      const failure = item.request.failureCode === 'SLACK_ANALYSIS_QUEUE_FULL' ? 'SLACK_ANALYSIS_QUEUE_FULL'
        : item.request.thread?.complete ? 'SLACK_ANALYSIS_INVALID_INPUT' : 'SLACK_ANALYSIS_INCOMPLETE_THREAD';
      this.start(item, payload, now, failure);
      if (this.active || this.limitedDay === now.toISOString().slice(0, 10)) return;
    }
  }

  private start(item: SlackAnalysisSourceItem, payload: SlackAnalysisPayload | null, now: Date, failureCode: SlackAnalysisFailureCode): void {
    const { workspaceId, channelId, messageTs, revision, listItemId } = item.request;
    const result = this.store.begin({ workspaceId, channelId, messageTs, revision,
      sourceHash: item.request.sourceHash ?? hashReadonlyValue(canonicalReadonlyJson(item.request)), policyHash, scopeHash: this.scopeHash,
      expiresAt: new Date(Math.min(Date.parse(item.expiresAt), now.getTime() + 86_400_000)).toISOString() }, now);
    if (result.kind === 'duplicate') return;
    if (result.kind === 'daily_limit') {
      this.limitedDay = now.toISOString().slice(0, 10); this.snapshots.clear();
      this.notify({ event: 'slack-analysis', status: 'DAILY_LIMIT', runId: null, failureCode: null }); return;
    }
    const record = result.record;
    if (!payload || payload.sourceHash !== item.request.sourceHash) {
      this.notice(this.store.finish(record.runId, { status: 'BLOCKED', failureCode }, now), listItemId); return;
    }
    const active: ActiveAnalysis = { record, payload, itemId: listItemId, controller: new AbortController(), pending: Promise.resolve() };
    this.active = active; this.notice(record, listItemId);
    active.pending = Promise.resolve().then(() => this.analyze(active))
      .catch(error => { this.fatal = error; }).finally(() => { if (this.active === active) this.active = null; });
  }

  private hasCurrentSocket(connection: SlackConnectionState | null, updatedAt: string): boolean {
    return connection?.state === 'connected' && connection.at >= this.startedAt.toISOString() && updatedAt >= connection.at;
  }
  private notice(record: SlackAnalysisRecord, itemId?: string): void {
    const location = getSlackListIds(this.receiver).includes(record.channelId)
      ? { listId: record.channelId, ...(itemId ? { itemId } : {}), commentId: record.messageTs }
      : { channelId: record.channelId, messageTs: record.messageTs };
    this.notify({ event: 'slack-analysis', status: record.status, runId: record.runId,
      ...location, failureCode: record.failureCode });
  }
  private current(record: SlackAnalysisRecord): SlackAnalysisSourceItem | null {
    return this.source.find(record.workspaceId, record.channelId, record.messageTs, this.now());
  }
  private invalidateChangedReports(now: Date): void {
    for (const record of this.store.list(now)) {
      if (record.status !== 'REPORTED') continue;
      if (!this.receiver.listAnalysisEnabled && getSlackListIds(this.receiver).includes(record.channelId)) continue;
      const item = this.current(record);
      const sameScope = record.scopeHash === this.scopeHash || (record.scopeHash === this.legacyScopeHash && item?.request.legacySourceHash === record.sourceHash);
      const same = sameScope && item !== null && matchesReportedSource(item.request, record, this.receiver);
      if (!same) this.notice(this.store.invalidate(record.runId, now), item?.request.listItemId);
    }
  }
  private assertCurrent(record: SlackAnalysisRecord, payload: SlackAnalysisPayload): void {
    if (this.stopped || this.active?.controller.signal.aborted) throw new HarnessError('SLACK_ANALYSIS_CANCELLED');
    const now = this.now();
    if (record.expiresAt <= now.toISOString()) throw new HarnessError('SLACK_ANALYSIS_EXPIRED');
    if (this.active?.itemId === undefined && !this.hasCurrentSocket(this.source.connection(), payload.source.updatedAt)) {
      throw new HarnessError('SLACK_ANALYSIS_CONNECTION_GAP');
    }
    const item = this.current(record);
    if (!this.isCurrentSnapshot(item, payload.source, payload.sourceHash, this.active?.itemId, payload.evidence.length)) {
      throw new HarnessError('SLACK_ANALYSIS_SOURCE_CHANGED');
    }
    if (this.store.find(record.runId, now)?.status !== 'RUNNING') throw new HarnessError('SLACK_ANALYSIS_SOURCE_CHANGED');
  }
  private async analyze(active: ActiveAnalysis): Promise<void> {
    const { record, payload, controller } = active;
    let responseReceived = false;
    try {
      this.assertCurrent(record, payload);
      const raw = await this.model(record.runId).transmit(payload.dispatch, controller.signal,
        () => this.assertCurrent(record, payload), () => this.assertCurrent(record, payload));
      responseReceived = true; this.assertCurrent(record, payload);
      if (raw.verification.upstreamCalls !== 1 || raw.verification.relayCompleted !== true
        || raw.verification.credentialReflection !== 'passed' || raw.verification.responseValidation !== 'codex-native-output-v1'
        || raw.finalTextHash !== hashReadonlyValue(raw.text) || !/^[a-f0-9]{64}$/u.test(raw.responseHash)) {
        throw new HarnessError('SLACK_ANALYSIS_INVALID_RESPONSE');
      }
      const report = parseSlackAnalysisResponse(raw.text, payload);
      this.assertCurrent(record, payload);
      this.notice(this.store.finish(record.runId, { status: 'REPORTED', report, responseHash: raw.responseHash }, this.now()), active.itemId);
    } catch (error) {
      const unsafe = error instanceof HarnessError
        && ['READONLY_RELAY_LIFECYCLE_UNSAFE', 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED'].includes(error.code);
      const current = this.store.find(record.runId, this.now());
      if (current?.status !== 'RUNNING') {
        if (unsafe) throw error;
        return;
      }
      const failureCode = this.stopped || controller.signal.aborted ? 'SLACK_ANALYSIS_CANCELLED'
        : error instanceof HarnessError && ['SLACK_ANALYSIS_SOURCE_CHANGED', 'SLACK_ANALYSIS_CONNECTION_GAP', 'SLACK_ANALYSIS_EXPIRED'].includes(error.code)
          ? error.code as 'SLACK_ANALYSIS_SOURCE_CHANGED' | 'SLACK_ANALYSIS_CONNECTION_GAP' | 'SLACK_ANALYSIS_EXPIRED'
          : responseReceived ? 'SLACK_ANALYSIS_INVALID_RESPONSE' : 'SLACK_ANALYSIS_MODEL_FAILED';
      this.notice(this.store.finish(record.runId, { status: 'FAILED', failureCode }, this.now()), active.itemId);
      if (unsafe) throw error;
    }
  }
  async waitForIdle(): Promise<void> { await this.active?.pending; if (this.fatal) throw this.fatal; }
  async close(): Promise<void> {
    this.stopped = true; this.snapshots.clear(); this.active?.controller.abort(); await this.waitForIdle();
  }
}
