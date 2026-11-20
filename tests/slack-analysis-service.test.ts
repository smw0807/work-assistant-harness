import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SlackAnalysisService } from '../src/application/analyze-slack.js';
import { SlackReceptionService } from '../src/application/receive-slack.js';
import { SqliteSlackAnalysisSource } from '../src/adapters/slack-analysis-source.js';
import { SqliteSlackAnalysisStore } from '../src/adapters/sqlite-slack-analysis.js';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import { appendSlackAnalysisResults } from '../src/cli/slack-analysis-results.js';
import type { SlackWorkerOptions } from '../src/cli/slack.js';
import { HarnessError } from '../src/domain/errors.js';
import type { ReadonlyReport } from '../src/domain/readonly-investigation.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import type { SlackReceiverConfig, SlackThreadSnapshot } from '../src/domain/slack.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../src/ports/readonly-relay.js';
import { hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const receiver: SlackReceiverConfig = { workspaceId: 'W_SYNTHETIC', channelIds: ['C_SYNTHETIC'], targetUserId: 'U_OWNER',
  retentionHours: 24, maxPending: 100, thread: { maxMessages: 30, maxPages: 3, maxBytes: 16384 }, liveReadEnabled: false };
const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/never-read-codex',
  codexSha256: '3'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 };
const startedAt = new Date('2026-11-20T00:00:00.000Z');
const messageTs = '1795000000.000001';
const requestText = '<@U_OWNER> 합성 일정의 확인을 부탁합니다.';
const created = (ts = messageTs, eventId = 'Ev_SYNTHETIC') => ({
  type: 'events_api', envelope_id: `Envelope_${eventId}`, payload: {
    type: 'event_callback', team_id: receiver.workspaceId, event_id: eventId,
    event: { type: 'message', channel: receiver.channelIds[0]!, user: 'U_REQUESTER', ts, text: requestText },
  },
});
const changed = (kind: 'edited' | 'deleted') => ({
  type: 'events_api', envelope_id: `Envelope_${kind}`, payload: {
    type: 'event_callback', team_id: receiver.workspaceId, event_id: `Ev_${kind}`,
    event: kind === 'deleted'
      ? { type: 'message', subtype: 'message_deleted', channel: receiver.channelIds[0]!, deleted_ts: messageTs, event_ts: '1795000001.000001' }
      : { type: 'message', subtype: 'message_changed', channel: receiver.channelIds[0]!, event_ts: '1795000001.000001',
        message: { user: 'U_REQUESTER', ts: messageTs, text: '멘션을 제거했습니다.', edited: { ts: '1795000001.000001' } } },
  },
});
const report = (ts = messageTs): ReadonlyReport => ({ classification: 'question', summary: '일정을 확인해 달라는 요청입니다.',
  facts: [{ text: '일정 확인을 요청했습니다.', references: [{ evidenceId: `slack-message-${ts}`, startLine: 1, endLine: 1 }] }],
  hypotheses: [], answerDraft: '일정 확인 후 알려드리겠습니다.', questions: [], suggestions: [], limitations: ['실제 일정과 외부 자료는 확인하지 않았습니다.'] });
const response = (ts = messageTs): ReadonlyRelayTransmissionResult => {
  const text = JSON.stringify(report(ts));
  return { text, finalTextHash: hashReadonlyValue(text), responseHash: hashReadonlyValue(`synthetic-response:${text}`), verification: {
    transport: 'fake', upstreamCalls: 1, isolation: 'not_run', credentialAccess: 'not_run', responseValidation: 'codex-native-output-v1',
    relayCompleted: true, credentialReflection: 'passed',
  } };
};
const deferred = <T>() => {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolvePromise = resolveValue; rejectPromise = rejectValue; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};
type ModelCall = { dispatch: ReadonlyRelayDispatch; signal: AbortSignal; beforeTransmission: () => void; beforeCredentialAccess: () => void };
type ModelBehavior = (call: ModelCall) => Promise<ReadonlyRelayTransmissionResult>;

/** Only the model is fake: intake, current-source lookup, one-use ledger and result invalidation use their real adapters. */
const fixture = async (context: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-slack-analysis-service-')));
  await chmod(directory, 0o700);
  let clock = new Date(startedAt.getTime() + 2000), calls = 0, credentials = 0, transmissions = 0, acknowledgements = 0;
  const now = () => new Date(clock);
  const inbox = new SqliteSlackInbox(join(directory, 'tasks.sqlite'), receiver);
  inbox.setConnection({ state: 'connected', reason: 'SYNTHETIC_CONNECTED', at: new Date(startedAt.getTime() + 1000).toISOString() });
  const store = new SqliteSlackAnalysisStore(join(directory, 'slack-analysis.sqlite'));
  const source = new SqliteSlackAnalysisSource(join(directory, 'tasks.sqlite'), receiver);
  let snapshot: (ts: string) => SlackThreadSnapshot = ts => ({ messages: [{ ts, user: 'U_REQUESTER', text: requestText }], complete: true, reason: null });
  const reception = new SlackReceptionService(receiver, inbox, { readThread: async (_channel, ts) => snapshot(ts) }, now);
  let behavior: ModelBehavior = async call => {
    call.beforeCredentialAccess(); call.beforeTransmission(); return response();
  };
  const model = (): ReadonlyRelayPort => ({ mode: 'live', transport: 'codex-cli-relay',
    transmit: async (dispatch, signal, beforeTransmission, beforeCredentialAccess) => {
      calls += 1;
      return behavior({ dispatch, signal,
        beforeCredentialAccess: () => { beforeCredentialAccess(); credentials += 1; },
        beforeTransmission: () => { beforeTransmission(); transmissions += 1; } });
    } });
  const services: SlackAnalysisService[] = [];
  const closers: (() => void)[] = [];
  const serviceFor = (sessionStart = startedAt, reopened = false) => {
    const currentSource = reopened ? new SqliteSlackAnalysisSource(join(directory, 'tasks.sqlite'), receiver) : source;
    const currentStore = reopened ? new SqliteSlackAnalysisStore(join(directory, 'slack-analysis.sqlite')) : store;
    if (reopened) closers.push(() => { currentSource.close(); currentStore.close(); });
    const service = new SlackAnalysisService(currentSource, currentStore, receiver, config, model, sessionStart, () => {}, now);
    services.push(service); return service;
  };
  const service = serviceFor();
  context.after(async () => {
    for (const current of services) { try { await current.close(); } catch { /* Fatal lifecycle failures are asserted in the test. */ } }
    for (const close of closers) close();
    source.close(); store.close(); inbox.close(); await rm(directory, { recursive: true, force: true });
  });
  const receive = async (input: unknown = created()) => {
    const result = await reception.receive(input, async () => { acknowledgements += 1; });
    await reception.drain(); return result;
  };
  const assertReportRemoved = (runId: string) => {
    assert.equal(store.find(runId, now())?.report, null);
    const database = new DatabaseSync(join(directory, 'slack-analysis.sqlite'), { readOnly: true });
    try { assert.equal(database.prepare('SELECT report_json FROM slack_analysis_runs WHERE run_id = ?').get(runId)?.report_json, null); }
    finally { database.close(); }
  };
  return { directory, now, inbox, store, source, reception, service, serviceFor, receive, assertReportRemoved,
    setNow: (value: Date) => { clock = value; }, advance: () => { clock = new Date(clock.getTime() + 1000); },
    setSnapshot: (value: (ts: string) => SlackThreadSnapshot) => { snapshot = value; },
    setBehavior: (value: ModelBehavior) => { behavior = value; },
    counts: () => ({ calls, credentials, transmissions, acknowledgements }) };
};

test('complete reception runs one fake analysis and duplicate delivery or reopened service never retransmits', async context => {
  const value = await fixture(context);
  assert.equal(await value.receive(), 'accepted');
  assert.equal(value.inbox.list()[0]?.status, 'RECORDED');
  assert.equal(value.counts().calls, 0);
  value.service.tick(); await value.service.waitForIdle();
  const record = value.store.list(value.now())[0]!;
  assert.equal(record.status, 'REPORTED'); assert.deepEqual(record.report, report());
  assert.deepEqual(value.counts(), { calls: 1, credentials: 1, transmissions: 1, acknowledgements: 1 });
  assert.equal(await value.receive(), 'duplicate');
  value.service.tick(); await value.service.waitForIdle(); await value.service.close();
  const reopened = value.serviceFor(startedAt, true);
  assert.equal(reopened.recover(), 0); reopened.tick(); await reopened.waitForIdle();
  assert.equal(value.store.list(value.now()).length, 1); assert.equal(value.counts().calls, 1);
});

test('a new session skips prior-session intake and disconnected or pre-session connection states', async context => {
  const value = await fixture(context); await value.receive(); await value.service.close();
  value.advance(); const sessionStart = value.now();
  const later = value.serviceFor(sessionStart, true);
  later.tick(); assert.equal(value.counts().calls, 0);
  value.inbox.setConnection({ state: 'connected', reason: 'SYNTHETIC_RECONNECTED', at: value.now().toISOString() });
  later.tick(); assert.equal(value.store.list(value.now()).length, 0);
  value.advance(); await value.receive(created('1795000002.000001', 'Ev_FRESH'));
  value.setBehavior(async call => { call.beforeCredentialAccess(); call.beforeTransmission(); return response('1795000002.000001'); });
  value.inbox.setConnection({ state: 'gap', reason: 'SYNTHETIC_GAP', at: value.now().toISOString() });
  later.tick(); assert.equal(value.counts().calls, 0);
  value.inbox.setConnection({ state: 'connected', reason: 'SYNTHETIC_RECONNECTED', at: value.now().toISOString() });
  later.tick(); await later.waitForIdle();
  assert.equal(value.counts().calls, 1); assert.equal(value.store.list(value.now())[0]?.messageTs, '1795000002.000001');
});

test('an incomplete thread is recorded as blocked once and never reaches the model', async context => {
  const value = await fixture(context);
  value.setSnapshot(ts => ({ messages: [{ ts, user: 'U_REQUESTER', text: requestText }], complete: false, reason: 'THREAD_LIMIT_REACHED' }));
  await value.receive(); value.service.tick(); await value.service.waitForIdle(); value.service.tick();
  const record = value.store.list(value.now())[0]!;
  assert.equal(record.status, 'BLOCKED'); assert.equal(record.failureCode, 'SLACK_ANALYSIS_INCOMPLETE_THREAD');
  assert.equal(record.report, null); assert.equal(value.counts().calls, 0); assert.equal(value.store.list(value.now()).length, 1);
});

for (const kind of ['edited', 'deleted'] as const) {
  test(`a ${kind} request invalidates the existing result and removes its stored report`, async context => {
    const value = await fixture(context); await value.receive(); value.service.tick(); await value.service.waitForIdle();
    const runId = value.store.list(value.now())[0]!.runId;
    value.advance(); await value.receive(changed(kind)); value.service.tick(); await value.service.waitForIdle();
    assert.equal(value.store.find(runId, value.now())?.status, 'INVALIDATED');
    value.assertReportRemoved(runId); assert.equal(value.counts().calls, 1);
  });
}

for (const gate of ['credential', 'transmission'] as const) {
  test(`the ${gate} callback rechecks the latest source before permitting the fake action`, async context => {
    const value = await fixture(context); await value.receive();
    value.setBehavior(async call => {
      if (gate === 'transmission') call.beforeCredentialAccess();
      value.advance(); await value.receive(changed('edited'));
      if (gate === 'credential') call.beforeCredentialAccess(); else call.beforeTransmission();
      assert.fail('changed source must block this action');
    });
    value.service.tick(); await value.service.waitForIdle();
    const record = value.store.list(value.now())[0]!;
    assert.equal(record.status, 'FAILED'); assert.equal(record.failureCode, 'SLACK_ANALYSIS_SOURCE_CHANGED');
    assert.equal(value.counts().credentials, gate === 'transmission' ? 1 : 0);
    assert.equal(value.counts().transmissions, 0); assert.equal(record.report, null);
  });
}

test('a connection gap aborts the active model and a late successful response cannot publish', async context => {
  const value = await fixture(context), entered = deferred<AbortSignal>(), finish = deferred<ReadonlyRelayTransmissionResult>();
  await value.receive();
  value.setBehavior(async call => { call.beforeCredentialAccess(); call.beforeTransmission(); entered.resolve(call.signal); return finish.promise; });
  value.service.tick(); const signal = await entered.promise;
  value.advance(); value.inbox.setConnection({ state: 'gap', reason: 'SYNTHETIC_GAP', at: value.now().toISOString() });
  value.service.tick(); assert.equal(signal.aborted, true);
  finish.resolve(response()); await value.service.waitForIdle();
  const record = value.store.list(value.now())[0]!;
  assert.equal(record.status, 'INVALIDATED'); value.assertReportRemoved(record.runId);
  value.service.tick(); assert.equal(value.counts().calls, 1);
});

test('closing analysis propagates cancellation and never starts a queued request', async context => {
  const value = await fixture(context), entered = deferred<AbortSignal>();
  await value.receive(); await value.receive(created('1795000002.000001', 'Ev_QUEUED'));
  value.setBehavior(async call => {
    call.beforeCredentialAccess(); call.beforeTransmission(); entered.resolve(call.signal);
    return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new HarnessError('READONLY_RELAY_CANCELLED')), { once: true }));
  });
  value.service.tick(); const signal = await entered.promise; await value.service.close();
  assert.equal(signal.aborted, true); value.service.tick();
  const record = value.store.list(value.now())[0]!;
  assert.equal(record.status, 'FAILED'); assert.equal(record.failureCode, 'SLACK_ANALYSIS_CANCELLED');
  assert.equal(value.counts().calls, 1); assert.equal(value.store.list(value.now()).length, 1);
});

for (const code of ['READONLY_RELAY_LIFECYCLE_UNSAFE', 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED']) {
  test(`${code} stays fatal after invalidation and blocks all later model calls`, async context => {
    const value = await fixture(context), entered = deferred<AbortSignal>(), finish = deferred<ReadonlyRelayTransmissionResult>();
    await value.receive(); await value.receive(created('1795000002.000001', 'Ev_QUEUED'));
    value.setBehavior(async call => { call.beforeCredentialAccess(); call.beforeTransmission(); entered.resolve(call.signal); return finish.promise; });
    value.service.tick(); const signal = await entered.promise;
    value.advance(); await value.receive(changed('deleted')); value.service.tick();
    assert.equal(signal.aborted, true); assert.equal(value.store.list(value.now())[0]?.status, 'INVALIDATED');
    finish.reject(new HarnessError(code));
    await assert.rejects(value.service.waitForIdle(), { code });
    assert.throws(() => value.service.tick(), { code });
    assert.equal(value.counts().calls, 1); assert.equal(value.store.list(value.now()).length, 1);
  });
}

test('the current source is checked again after a model response and stale output is not saved', async context => {
  const value = await fixture(context); await value.receive();
  value.setBehavior(async call => {
    call.beforeCredentialAccess(); call.beforeTransmission(); value.advance(); await value.receive(changed('deleted')); return response();
  });
  value.service.tick(); await value.service.waitForIdle();
  const record = value.store.list(value.now())[0]!;
  assert.equal(record.status, 'FAILED'); assert.equal(record.failureCode, 'SLACK_ANALYSIS_SOURCE_CHANGED'); value.assertReportRemoved(record.runId);
});

test('list and inspect read stored analysis without a model config and invalidate edited evidence', async context => {
  const value = await fixture(context); await value.receive(); value.service.tick(); await value.service.waitForIdle();
  const options: SlackWorkerOptions = { command: 'slack-inspect', sourceRoot: resolve('.'), dataDirectory: value.directory,
    eventsPath: '', channelId: receiver.channelIds[0]!, messageTs, config: receiver,
    analysisConfigPath: join(value.directory, 'nonexistent-model-config.json') };
  const inspected = JSON.parse(appendSlackAnalysisResults('{}', options, value.now()));
  assert.deepEqual(inspected.analysis.results[0].report, report());
  assert.equal(inspected.analysis.semanticAccuracyVerified, false);
  assert.equal(inspected.analysis.repositoryAccess, 'not_run'); assert.equal(inspected.analysis.messageDelivery, 'not_run');
  const listed = JSON.parse(appendSlackAnalysisResults('{}', { ...options, command: 'slack-list' }, value.now()));
  assert.equal(Object.hasOwn(listed.analysis.results[0], 'report'), false);
  value.advance(); await value.receive(changed('edited'));
  const stale = JSON.parse(appendSlackAnalysisResults('{}', options, value.now()));
  assert.equal(stale.analysis.results[0].status, 'INVALIDATED'); assert.equal(stale.analysis.results[0].report, null);
  value.assertReportRemoved(stale.analysis.results[0].runId); assert.equal(value.counts().calls, 1);
});
