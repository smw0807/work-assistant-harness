import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SlackPostCheckService } from '../src/application/verify-slack-post.js';
import type { OfflinePostIntent } from '../src/domain/slack-post.js';
import {
  assertOfflinePostIntent, createOfflinePostIntent, defaultSlackPostConfig, hashOfflinePostIntent,
  hashPostThread, normalizePostThread, offlinePostBody, offlineThreadMessages,
} from '../src/policy/slack-post-policy.js';

const now = new Date('2026-11-11T00:00:00.000Z');
const owner = 'os-user:501';
const wireThread = () => ({ ok: true, messages: offlineThreadMessages.map(({ revision, ...message }) => ({
  ...message, edited: { ts: revision },
})), has_more: false, response_metadata: { next_cursor: '' } });

test('진단 intent는 모의 답장 승인과 분리되고 재해시한 live·목적지·본문·설정 변조도 거부한다', () => {
  const intent = createOfflinePostIntent(owner, now);
  assertOfflinePostIntent(intent, { ...defaultSlackPostConfig }, now);
  const changes: ((value: OfflinePostIntent) => void)[] = [
    (value) => { Object.assign(value, { policy: 'synthetic-reply-v1' }); },
    (value) => { Object.assign(value, { mode: 'mock' }); },
    (value) => { Object.assign(value, { mode: 'live' }); },
    (value) => { value.channelId = 'D_DM'; },
    (value) => { value.workspaceId = 'T_OTHER'; },
    (value) => { value.threadTs = '1700000000.000003'; },
    (value) => { value.requestRevision = '1700000000.000099'; },
    (value) => { value.bodyHash = 'f'.repeat(64); },
    (value) => { value.configHash = 'f'.repeat(64); },
    (value) => { Object.assign(value, { body: 'unexpected source text' }); },
    (value) => { Object.assign(value, { token: 'SYNTHETIC_MUST_NOT_BE_INPUT' }); },
  ];
  for (const change of changes) {
    const changed = structuredClone(intent);
    change(changed);
    changed.intentHash = hashOfflinePostIntent(changed);
    assert.throws(() => assertOfflinePostIntent(changed, { ...defaultSlackPostConfig }, now));
  }
  for (const config of [
    { ...defaultSlackPostConfig, liveEnabled: true }, { ...defaultSlackPostConfig, url: 'https://synthetic.invalid' },
    { ...defaultSlackPostConfig, requestTimeoutMs: 5000 }, { ...defaultSlackPostConfig, botId: 'B_OTHER' },
  ]) assert.throws(() => assertOfflinePostIntent(intent, config as typeof defaultSlackPostConfig, now), { code: 'SLACK_POST_INVALID_CONFIG' });
});

test('진단 입력 만료는 소유자 승인 TTL이 아니며 경계 시각과 잘못된 소유자·시간을 차단한다', () => {
  const intent = createOfflinePostIntent(owner, now);
  assertOfflinePostIntent(intent, { ...defaultSlackPostConfig }, new Date(now.getTime() + 59_999));
  for (const time of [new Date(now.getTime() - 1), new Date(intent.expiresAt)]) {
    assert.throws(() => assertOfflinePostIntent(intent, { ...defaultSlackPostConfig }, time), { code: 'SLACK_POST_INTENT_EXPIRED' });
  }
  assert.throws(() => createOfflinePostIntent('U_OWNER', now));
  assert.throws(() => createOfflinePostIntent(owner, new Date(NaN)));
  const badExpiry = { ...intent, expiresAt: new Date(now.getTime() + 120_000).toISOString() };
  badExpiry.intentHash = hashOfflinePostIntent(badExpiry);
  assert.throws(() => assertOfflinePostIntent(badExpiry, { ...defaultSlackPostConfig }, now));
});

test('스레드 fingerprint는 응답 순서와 무관하며 정밀한 timestamp·동일 본문 편집·새 reply를 구분한다', () => {
  const messages = normalizePostThread(wireThread(), { ...defaultSlackPostConfig });
  assert.equal(hashPostThread(messages), hashPostThread([...messages].reverse()));
  const precise = [
    { ts: '1700000000.00000000000000000001', user: 'U_ONE', text: '합성', revision: '1700000000.00000000000000000001' },
    { ts: '1700000000.00000000000000000002', user: 'U_TWO', text: '합성', revision: '1700000000.00000000000000000002' },
  ];
  const normalized = normalizePostThread({ ok: true, messages: [...precise].reverse() }, { ...defaultSlackPostConfig });
  assert.deepEqual(normalized.map((message) => message.ts), precise.map((message) => message.ts));
  const edited = wireThread();
  edited.messages[1]!.edited.ts = '1700000000.000099';
  assert.notEqual(hashPostThread(normalizePostThread(edited, { ...defaultSlackPostConfig })), hashPostThread(messages));
  assert.notEqual(hashPostThread([...messages, ...precise]), hashPostThread(messages));
});

test('부분·중복·다른 스레드·잘못된 edited timestamp는 완전한 문맥으로 승인하지 않는다', () => {
  for (const payload of [
    { ...wireThread(), has_more: true }, { ...wireThread(), has_more: 'false' },
    { ...wireThread(), response_metadata: { next_cursor: 'synthetic-cursor' } },
    { ...wireThread(), messages: [] }, { ...wireThread(), messages: [...wireThread().messages, wireThread().messages[0]] },
    { ...wireThread(), messages: [{ ...wireThread().messages[0], thread_ts: '1700000000.000003' }] },
    { ...wireThread(), messages: [{ ...wireThread().messages[0], edited: { ts: 1700000000 } }] },
    { ...wireThread(), messages: [{ ts: '1.0', user: 'U_ONE', text: '' }, { ts: '1.00', user: 'U_TWO', text: '' }] },
  ]) assert.throws(() => normalizePostThread(payload, { ...defaultSlackPostConfig }));
});

test('전체 HTTP 계약 진단은 예상 차단까지 통과로 기록하고 원문·자격증명 없이 live 차단을 유지한다', async () => {
  const report = await new SlackPostCheckService(() => now).verify('all', owner, randomUUID());
  assert.equal(report.status, 'passed');
  assert.equal(report.scenarios.length, 15);
  assert.equal(report.liveEnabled, false);
  assert.equal(report.scenarios.find((scenario) => scenario.fixture === 'success')?.result.status, 'OFFLINE_CONFIRMED');
  assert.equal(report.scenarios.find((scenario) => scenario.fixture === 'timeout')?.result.status, 'UNKNOWN');
  assert.equal(report.checks.find((check) => check.name === 'external_message_delivery')?.status, 'not_run');
  const output = JSON.stringify(report);
  for (const text of [offlinePostBody, 'SYNTHETIC_OFFLINE_TOKEN', 'Authorization', 'Bearer ', offlineThreadMessages[0]!.text]) {
    assert.equal(output.includes(text), false);
  }
});
