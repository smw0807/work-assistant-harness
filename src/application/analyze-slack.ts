import type { SlackAnalysisSource, SlackAnalysisSourceItem } from '../adapters/slack-analysis-source.js';
import { SqliteSlackAnalysisStore, type SlackAnalysisRecord } from '../adapters/sqlite-slack-analysis.js';
import type { SlackReceiverConfig } from '../domain/slack.js';
import type { ReadonlyRelayConfig } from '../domain/readonly-relay.js';
import type { SlackAnalysisPayload, SlackAnalysisModelPort } from '../domain/slack-analysis.js';
import { SLACK_ANALYSIS_POLICY } from '../domain/slack-analysis.js';
import { HarnessError } from '../domain/errors.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { buildSlackAnalysisPayload, parseSlackAnalysisResponse } from '../policy/slack-analysis.js';

export interface SlackAnalysisNotice {
  event: 'slack-analysis'; status: string; runId: string | null;
  channelId?: string; messageTs?: string; failureCode: string | null;
}
interface ActiveAnalysis { record: SlackAnalysisRecord; payload: SlackAnalysisPayload; controller: AbortController; pending: Promise<void> }
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
    this.scopeHash = hashReadonlyValue(canonicalReadonlyJson({ receiver, config, policyHash }));
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
    const connection = this.source.connection();
    if (!connection || connection.state !== 'connected' || connection.at < this.startedAt.toISOString()) return;
    if (this.limitedDay === now.toISOString().slice(0, 10)) return;
    for (const item of this.source.list(now, this.startedAt)) {
      // A reconnect cannot prove that an older collected thread is still current.
      if (item.request.updatedAt < connection.at) continue;
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
        this.notice(blocked); continue;
      }
      const active: ActiveAnalysis = { record, payload, controller: new AbortController(), pending: Promise.resolve() };
      this.active = active; this.notice(record);
      // Assign active before invoking a synchronous test port or any asynchronous native work.
      active.pending = Promise.resolve().then(() => this.analyze(active))
        .catch(error => { this.fatal = error; }).finally(() => { if (this.active === active) this.active = null; });
      return;
    }
  }

  private notice(record: SlackAnalysisRecord): void {
    this.notify({ event: 'slack-analysis', status: record.status, runId: record.runId,
      channelId: record.channelId, messageTs: record.messageTs, failureCode: record.failureCode });
  }
  private current(record: SlackAnalysisRecord): SlackAnalysisSourceItem | null {
    return this.source.find(record.workspaceId, record.channelId, record.messageTs, this.now());
  }
  private invalidateChangedReports(now: Date): void {
    for (const record of this.store.list(now)) {
      if (record.status !== 'REPORTED') continue;
      const item = this.current(record);
      let same = false;
      try { same = record.scopeHash === this.scopeHash && item !== null
        && buildSlackAnalysisPayload(item.request, this.receiver, this.config).sourceHash === record.sourceHash; } catch { /* Invalid or incomplete source no longer supports the report. */ }
      if (!same) this.notice(this.store.invalidate(record.runId, now));
    }
  }
  private assertCurrent(record: SlackAnalysisRecord, payload: SlackAnalysisPayload): void {
    if (this.stopped || this.active?.controller.signal.aborted) throw new HarnessError('SLACK_ANALYSIS_CANCELLED');
    const now = this.now(), connection = this.source.connection();
    if (record.expiresAt <= now.toISOString()) throw new HarnessError('SLACK_ANALYSIS_EXPIRED');
    if (!connection || connection.state !== 'connected' || connection.at < this.startedAt.toISOString()
      || payload.source.updatedAt < connection.at) throw new HarnessError('SLACK_ANALYSIS_CONNECTION_GAP');
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
      this.notice(this.store.finish(record.runId, { status: 'REPORTED', report, responseHash: raw.responseHash }, this.now()));
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
      this.notice(this.store.finish(record.runId, { status: 'FAILED', failureCode }, this.now()));
      if (unsafe) throw error;
    }
  }
  async waitForIdle(): Promise<void> { await this.active?.pending; if (this.fatal) throw this.fatal; }
  async close(): Promise<void> {
    this.stopped = true; this.active?.controller.abort(); await this.waitForIdle();
  }
}
