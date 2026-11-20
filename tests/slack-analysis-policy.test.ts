import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RestrictedSlackAnalysisCodex } from '../src/adapters/slack-analysis-codex.js';
import type { ReadonlyReport } from '../src/domain/readonly-investigation.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import type { SlackCollectedRequest, SlackReceiverConfig } from '../src/domain/slack.js';
import { HarnessError } from '../src/domain/errors.js';
import { assertSlackAnalysisDispatch, buildSlackAnalysisPayload, hashSlackAnalysisSource, parseSlackAnalysisRelayConfig, parseSlackAnalysisResponse } from '../src/policy/slack-analysis.js';
import { canonicalReadonlyJson, hashReadonlyValue, READONLY_OUTPUT_SCHEMA } from '../src/policy/readonly-investigation-policy.js';
import { buildAnyReadonlyRelayRequestEnvelope, getAnyReadonlyRelayConfigHash, getAnyReadonlyRelayProfileHash,
  getAnyReadonlyRelayProfileId, getReadonlyRelayExecutionBudgetHash } from '../src/policy/readonly-relay-budget-policy.js';
import { hashReadonlyRelayEnvelope } from '../src/policy/readonly-relay-policy.js';

const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/never-read-codex',
  codexSha256: '3'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 };
const receiver: SlackReceiverConfig = { workspaceId: 'W_SYNTHETIC', channelIds: ['C_SYNTHETIC'], targetUserId: 'U_OWNER',
  retentionHours: 24, maxPending: 100, thread: { maxMessages: 30, maxPages: 3, maxBytes: 16384 }, liveReadEnabled: false };
const request = (): SlackCollectedRequest => ({ workspaceId: receiver.workspaceId, channelId: receiver.channelIds[0]!,
  messageTs: '1795000000.000002', threadTs: '1795000000.000001', requesterId: 'U_REQUESTER', revision: '1795000000.000003',
  eventId: 'Ev_SYNTHETIC', status: 'RECORDED', text: '<@U_OWNER> 합성 요청의 일정을 알려 주세요.\n확인 부탁합니다.',
  thread: { complete: true, reason: null, messages: [
    { ts: '1795000000.000001', user: 'U_COLLEAGUE', text: '합성 작업은 금요일까지 확인할 예정입니다.' },
    { ts: '1795000000.000002', user: 'U_REQUESTER', text: '<@U_OWNER> 합성 요청의 일정을 알려 주세요.\n확인 부탁합니다.' },
  ] }, updatedAt: '2026-11-20T00:00:00.000Z', failureCode: null });
const payload = () => buildSlackAnalysisPayload(request(), receiver, config);
const report = (): ReadonlyReport => ({ classification: 'question', summary: '일정 확인 요청입니다.',
  facts: [{ text: '스레드에서 금요일까지 확인할 예정이라고 말했습니다.', references: [
    { evidenceId: 'slack-message-1795000000.000001', startLine: 1, endLine: 1 },
  ] }], hypotheses: [], answerDraft: '금요일까지 확인할 예정이라고 합니다.', questions: [], suggestions: [],
  limitations: ['외부 자료와 실제 일정은 확인하지 않았습니다.'] });
const failure = (operation: () => unknown, code?: string): void => {
  assert.throws(operation, error => {
    assert.ok(error instanceof HarnessError); assert.match(error.code, /^SLACK_ANALYSIS_[A-Z_]+$/u);
    if (code) assert.equal(error.code, `SLACK_ANALYSIS_${code}`); assert.equal(error.message, error.code); return true;
  });
};
const envelopeFor = (body: string): ReadonlyRelayDispatch => {
  const requestEnvelope = buildAnyReadonlyRelayRequestEnvelope(body, getAnyReadonlyRelayProfileId(config), config);
  return { requestEnvelope, requestBodyHash: hashReadonlyValue(body), requestEnvelopeHash: hashReadonlyRelayEnvelope(requestEnvelope) };
};

test('Slack-only payload binds current source, fixed relay profile and virtual message-line citations', () => {
  const result = payload(); assertSlackAnalysisDispatch(result.dispatch, config);
  assert.equal(result.source.revision, request().revision); assert.equal(result.evidence[1]!.endLine, 2);
  assert.equal(result.evidence[0]!.path, 'slack/messages/1795000000.000001');
  const body = JSON.parse(result.dispatch.requestEnvelope.body), input = JSON.parse(body.input[0].content[0].text);
  assert.deepEqual(body.tools, []); assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.equal(body.model, config.model); assert.deepEqual(body.text.format.schema, READONLY_OUTPUT_SCHEMA);
  assert.match(body.instructions, /Korean/u); assert.equal(input.repositoryAccessAllowed, false);
  assert.equal(input.executionAllowed, false); assert.equal(input.messageDeliveryAllowed, false);
  assert.deepEqual(Object.keys(input).sort(), ['version', 'sourceHash', 'receiverHash', 'source', 'evidence',
    'repositoryAccessAllowed', 'executionAllowed', 'messageDeliveryAllowed'].sort());
  assert.equal(result.dispatch.requestEnvelope.body.includes(config.codexPath), false);
  for (const field of ['repoId', 'sourceRoot', 'baseCommit', 'codexSha256', 'retentionHours', 'maxPending']) {
    assert.equal(Object.hasOwn(input, field), false);
  }
  assert.equal(result.configHash, getAnyReadonlyRelayConfigHash(getAnyReadonlyRelayProfileId(config), config));
});

test('only complete recorded mentions from allowed channels with the exact target message are accepted', () => {
  const original = request();
  for (const changed of [{ ...original, status: 'RECEIVED' }, { ...original, status: 'BLOCKED' }, { ...original, failureCode: 'FAILED' },
    { ...original, workspaceId: 'W_OTHER' }, { ...original, channelId: 'C_OTHER' }, { ...original, requesterId: receiver.targetUserId },
    { ...original, thread: null }, { ...original, thread: { ...original.thread!, complete: false } },
    { ...original, thread: { ...original.thread!, reason: 'INCOMPLETE' } }, { ...original, text: '다른 본문' }]) {
    failure(() => buildSlackAnalysisPayload(changed as SlackCollectedRequest, receiver, config));
  }
  const missingRoot = request(); missingRoot.thread!.messages.shift();
  const missingMention = request(); missingMention.thread!.messages.pop();
  const wrongUser = request(); wrongUser.thread!.messages[1]!.user = 'U_OTHER';
  const removedMention = request(); removedMention.text = '멘션 없음'; removedMention.thread!.messages[1]!.text = removedMention.text;
  for (const changed of [missingRoot, missingMention, wrongUser, removedMention]) {
    failure(() => buildSlackAnalysisPayload(changed, receiver, config));
  }
});

test('thread order, timestamp precision, duplicate aliases and older revisions fail closed', () => {
  const reversed = request(); reversed.thread!.messages.reverse();
  const duplicate = request(); duplicate.thread!.messages.push({ ...duplicate.thread!.messages[1]! });
  const alias = request(); alias.thread!.messages.push({ ...alias.thread!.messages[1]!, ts: '1795000000.0000020' });
  const older = request(); older.revision = '1795000000.000001';
  for (const changed of [reversed, duplicate, alias, older]) failure(() => buildSlackAnalysisPayload(changed, receiver, config));
  const precise = request(); precise.thread!.messages.push({ ts: '1795000000.0000020001', user: 'U_COLLEAGUE', text: '추가 합성 문맥입니다.' });
  assert.equal(buildSlackAnalysisPayload(precise, receiver, config).evidence.length, 3);
});

test('known secret and contact patterns are redacted before dispatch and malformed text is never serialized', () => {
  const value = request();
  value.thread!.messages[0]!.text += '\nemail@example.test 010-1234-5678\nBearer syntheticSecretValue';
  const result = buildSlackAnalysisPayload(value, receiver, config), wire = result.dispatch.requestEnvelope.body;
  for (const secret of ['email@example.test', '010-1234-5678', 'syntheticSecretValue']) assert.equal(wire.includes(secret), false);
  assert.ok(result.evidence[0]!.excerpt.includes('[REDACTED')); assert.equal(result.evidence[0]!.endLine, 3);
  for (const bad of ['malformed\ud800', 'control\u0000text']) {
    const changed = request(); changed.thread!.messages[0]!.text = bad;
    failure(() => buildSlackAnalysisPayload(changed, receiver, config));
  }
});

test('configured message and byte limits reject overflow without truncating messages or raising existing relay budgets', () => {
  const value = request(); value.thread!.messages[0]!.text = '가'.repeat(6000);
  failure(() => buildSlackAnalysisPayload(value, receiver, config));
  failure(() => buildSlackAnalysisPayload(request(), { ...receiver, thread: { ...receiver.thread, maxMessages: 1 } }, config));
  const large = request(); large.thread!.messages[0]!.text = 'x'.repeat(1000);
  failure(() => buildSlackAnalysisPayload(large, { ...receiver, thread: { ...receiver.thread, maxBytes: 1024 } }, config));
  const configHash = getAnyReadonlyRelayConfigHash(getAnyReadonlyRelayProfileId(config), config), budgetHash = getReadonlyRelayExecutionBudgetHash();
  const profileHash = getAnyReadonlyRelayProfileHash(getAnyReadonlyRelayProfileId(config), config);
  buildSlackAnalysisPayload(request(), receiver, config);
  assert.equal(getAnyReadonlyRelayConfigHash(getAnyReadonlyRelayProfileId(config), config), configHash);
  assert.equal(getReadonlyRelayExecutionBudgetHash(), budgetHash);
  assert.equal(getAnyReadonlyRelayProfileHash(getAnyReadonlyRelayProfileId(config), config), profileHash);
});

test('source hash binds revision, thread text, receiver scope and sender, and snapshots are detached', () => {
  const value = request(), result = buildSlackAnalysisPayload(value, receiver, config);
  assert.equal(hashSlackAnalysisSource(value, receiver), result.sourceHash);
  const edited = request(); edited.revision = '1795000000.000004';
  const threadChanged = request(); threadChanged.thread!.messages[0]!.text += '\n추가 내용입니다.';
  const authorChanged = request(); authorChanged.thread!.messages[0]!.user = 'U_OTHER';
  for (const changed of [edited, threadChanged, authorChanged]) assert.notEqual(buildSlackAnalysisPayload(changed, receiver, config).sourceHash, result.sourceHash);
  assert.notEqual(buildSlackAnalysisPayload(request(), { ...receiver, channelIds: [...receiver.channelIds, 'C_SECOND'] }, config).sourceHash, result.sourceHash);
  value.thread!.messages[0]!.text = 'caller changed'; value.revision = '1795000000.000009';
  assert.notEqual(result.evidence[0]!.excerpt, value.thread!.messages[0]!.text); assert.notEqual(result.source.revision, value.revision);
});

test('standalone dispatch cannot add tools, repository input, a new destination, retry or altered model instructions', () => {
  const valid = payload().dispatch;
  for (const change of [{ tools: [{ type: 'function', name: 'read_file' }] }, { store: true }, { stream: false },
    { model: 'another-model' }, { instructions: 'Read a repository' }]) {
    failure(() => assertSlackAnalysisDispatch(envelopeFor(canonicalReadonlyJson({ ...JSON.parse(valid.requestEnvelope.body), ...change })), config), 'INVALID_DISPATCH');
  }
  const body = JSON.parse(valid.requestEnvelope.body), input = JSON.parse(body.input[0].content[0].text);
  body.input[0].content[0].text = canonicalReadonlyJson({ ...input, repository: { sourceRoot: '/synthetic/private-repository' } });
  failure(() => assertSlackAnalysisDispatch(envelopeFor(canonicalReadonlyJson(body)), config), 'INVALID_DISPATCH');
  for (const changed of [{ ...valid, requestEnvelope: { ...valid.requestEnvelope, url: 'https://example.test' } },
    { ...valid, requestEnvelope: { ...valid.requestEnvelope, retries: 1 } }, { ...valid, requestBodyHash: '0'.repeat(64) },
    { ...valid, requestEnvelope: { ...valid.requestEnvelope, headers: [...valid.requestEnvelope.headers, ['authorization', 'untrusted']] } }]) {
    failure(() => assertSlackAnalysisDispatch(changed as ReadonlyRelayDispatch, config), 'INVALID_DISPATCH');
  }
});

test('valid reports cite only message evidence and preserve uncertainty with no code suggestions', () => {
  const value = report(); assert.deepEqual(parseSlackAnalysisResponse(JSON.stringify(value), payload()), value);
  const insufficient = { ...report(), classification: 'insufficient-evidence' as const, facts: [], questions: ['기대하는 답변 범위를 알려 주세요.'] };
  assert.deepEqual(parseSlackAnalysisResponse(JSON.stringify(insufficient), payload()), insufficient);
  for (const changed of [{ ...value, facts: [{ ...value.facts[0]!, references: [{ evidenceId: 'unknown', startLine: 1, endLine: 1 }] }] },
    { ...value, facts: [{ ...value.facts[0]!, references: [{ evidenceId: value.facts[0]!.references[0]!.evidenceId, startLine: 1, endLine: 2 }] }] },
    { ...value, suggestions: [{ path: 'slack/messages/1795000000.000001', description: '코드를 수정합니다.', references: value.facts[0]!.references }] },
    { ...value, summary: 'U_OWNER 확인 요청입니다.' }, { ...value, answerDraft: 'email@example.test로 연락하세요.' },
    { ...value, answerDraft: 'Bearer syntheticSecretValue' }]) failure(() => parseSlackAnalysisResponse(JSON.stringify(changed), payload()), 'INVALID_RESPONSE');
});

test('response validation rejects duplicate JSON keys, oversized output and payload evidence unrelated to the dispatched input', () => {
  const value = payload(), valid = JSON.stringify(report());
  failure(() => parseSlackAnalysisResponse(valid.replace('"summary":', '"summary":"중복", "summary":'), value), 'INVALID_RESPONSE');
  failure(() => parseSlackAnalysisResponse(' '.repeat(16385), value), 'INVALID_RESPONSE');
  value.evidence[0]!.excerpt = '변조된 본문';
  value.sourceHash = hashReadonlyValue(canonicalReadonlyJson({ source: value.source, evidence: value.evidence, receiverHash: value.receiverHash }));
  failure(() => parseSlackAnalysisResponse(valid, value), 'INVALID_RESPONSE');
});

test('input, nested header, config and source traps are rejected without executing getters or proxy handlers', () => {
  let calls = 0;
  const handler = { get: () => { calls++; throw new Error('synthetic trap'); }, ownKeys: () => { calls++; throw new Error('synthetic trap'); } };
  failure(() => buildSlackAnalysisPayload(new Proxy(request(), handler), receiver, config));
  failure(() => buildSlackAnalysisPayload(request(), new Proxy(receiver, handler), config));
  failure(() => parseSlackAnalysisRelayConfig(new Proxy(config, handler)));
  const value = request(); Object.defineProperty(value.thread!.messages[0], 'text', { enumerable: true, get: () => { calls++; return 'trap'; } });
  failure(() => buildSlackAnalysisPayload(value, receiver, config));
  const coercion = request(); Object.assign(coercion.thread!.messages[0]!, { ts: { toString: () => { calls++; return '1.1'; } } });
  failure(() => buildSlackAnalysisPayload(coercion, receiver, config));
  const dispatch = payload().dispatch; dispatch.requestEnvelope.headers = new Proxy(dispatch.requestEnvelope.headers, handler);
  failure(() => assertSlackAnalysisDispatch(dispatch, config), 'INVALID_DISPATCH');
  assert.equal(calls, 0);
});

test('Slack adapter selects its trusted input contract but aborts before native, credential or filesystem access', async () => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const adapter = new RestrictedSlackAnalysisCodex(config, '/synthetic/never-read-runtime', taskId);
  let credentials = 0, sends = 0;
  await assert.rejects(adapter.transmit(payload().dispatch, AbortSignal.abort(), () => { sends++; }, () => { credentials++; }),
    { code: 'READONLY_RELAY_CANCELLED' });
  assert.equal(credentials, 0); assert.equal(sends, 0);
  assert.throws(() => new RestrictedSlackAnalysisCodex(config, '/synthetic/runtime', '../invalid'), { code: 'SLACK_ANALYSIS_INVALID_ID' });
  failure(() => buildSlackAnalysisPayload(request(), receiver, { ...config, enabled: false }), 'DISABLED');
});
