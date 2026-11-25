import type { SlackAnalysisSource, SlackAnalysisSourceItem } from '../adapters/slack-analysis-source.js';
import { SqliteSlackAnalysisStore, type SlackAnalysisRecord } from '../adapters/sqlite-slack-analysis.js';
import { getSlackListIds, type SlackConnectionState, type SlackReceiverConfig } from '../domain/slack.js';
import type { ReadonlyRelayConfig } from '../domain/readonly-relay.js';
import type { SlackAnalysisPayload, SlackAnalysisModelPort } from '../domain/slack-analysis.js';
import { SLACK_ANALYSIS_POLICY } from '../domain/slack-analysis.js';
import { HarnessError } from '../domain/errors.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { buildSlackAnalysisPayload, parseSlackAnalysisResponse } from '../policy/slack-analysis.js';

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
  private fatal: unknown = null;
  private stopped = false;
  private limitedDay: string | null = null;
  private readonly scopeHash: string;
  constructor(private readonly source: SlackAnalysisSource, private readonly store: SqliteSlackAnalysisStore,
    private readonly receiver: SlackReceiverConfig, private readonly config: ReadonlyRelayConfig,
    private readonly model: (runId: string) => SlackAnalysisModelPort,
    private readonly startedAt: Date, private readonly notify: (notice: SlackAnalysisNotice) => void = () => {},
    private readonly now: () => Date = () => new Date()) {
    const channelReceiver = { ...receiver };
    delete channelReceiver.listAnalysisEnabled;
    this.scopeHash = hashReadonlyValue(canonicalReadonlyJson({ receiver: channelReceiver, config, policyHash }));
  }

  recover(): number { return this.store.recover(this.now()); }

  tick(): void {
    if (this.fatal) throw this.fatal;
    if (this.stopped) return;
    const now = this.now(); this.store.prune(now);
    this.invalidateChangedReports(now);
    if (this.active) {
      try { this.assertCurrent(this.active.record, this.active.payload); }
      catch { this.active.controller.abort(); this.store.invalidate(this.active.record.runId, now); }
      return;
    }
    if (this.limitedDay === now.toISOString().slice(0, 10)) return;
    const connection = this.receiver.channelIds.length ? this.source.connection() : null;
    for (const item of this.source.list(now, this.startedAt)) {
      // 리스트 스냅샷은 독립적인 HTTP 조회 결과이므로 채널 소켓 재연결과 무관하다.
      const itemId = item.request.listItemId;
      if (itemId === undefined && !this.hasCurrentSocket(connection, item.request.updatedAt)) continue;
      let payload: SlackAnalysisPayload | null = null;
      try { payload = buildSlackAnalysisPayload(item.request, this.receiver, this.config); } catch { /* Persist a body-free blocked outcome below. */ }
      const result = this.store.begin({ workspaceId: item.request.workspaceId, channelId: item.request.channelId,
        messageTs: item.request.messageTs, revision: item.request.revision,
        sourceHash: payload?.sourceHash ?? hashReadonlyValue(canonicalReadonlyJson(item.request)),
        policyHash, scopeHash: this.scopeHash,
        expiresAt: new Date(Math.min(Date.parse(item.expiresAt), now.getTime() + 86_400_000)).toISOString() }, now);
      if (result.kind === 'duplicate') continue;
      if (result.kind === 'daily_limit') {
        this.limitedDay = now.toISOString().slice(0, 10);
        this.notify({ event: 'slack-analysis', status: 'DAILY_LIMIT', runId: null, failureCode: null }); return;
      }
      const record = result.record!;
      if (!payload) {
        const blocked = this.store.finish(record.runId, { status: 'BLOCKED', failureCode:
          item.request.thread?.complete === true ? 'SLACK_ANALYSIS_INVALID_INPUT' : 'SLACK_ANALYSIS_INCOMPLETE_THREAD' }, now);
        this.notice(blocked, itemId); continue;
      }
      const active: ActiveAnalysis = { record, payload, itemId, controller: new AbortController(), pending: Promise.resolve() };
      this.active = active; this.notice(record, itemId);
      // Assign active before invoking a synchronous test port or any asynchronous native work.
      active.pending = Promise.resolve().then(() => this.analyze(active))
        .catch(error => { this.fatal = error; }).finally(() => { if (this.active === active) this.active = null; });
      return;
    }
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
      let same = false;
      try { same = record.scopeHash === this.scopeHash && item !== null
        && buildSlackAnalysisPayload(item.request, this.receiver, this.config).sourceHash === record.sourceHash; } catch { /* Invalid or incomplete source no longer supports the report. */ }
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
    let sameSource = false;
    try { sameSource = item !== null && item.receivedAt >= this.startedAt.toISOString()
      && buildSlackAnalysisPayload(item.request, this.receiver, this.config).sourceHash === payload.sourceHash; }
    catch { /* An invalidated or incomplete snapshot is a source change, not a model failure. */ }
    if (!sameSource) throw new HarnessError('SLACK_ANALYSIS_SOURCE_CHANGED');
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
    this.stopped = true; this.active?.controller.abort(); await this.waitForIdle();
  }
}
