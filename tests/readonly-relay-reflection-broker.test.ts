import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startReadonlyRelayBroker, type ReadonlyRelayBroker, type ReadonlyRelayDispatchValidator,
  type ReadonlyRelayTransport } from '../src/adapters/readonly-relay-broker.js';
import { collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { SqlitePersonalReadonlyStore } from '../src/adapters/sqlite-personal-readonly-store.js';
import { PersonalReadonlyService } from '../src/application/investigate-personal-readonly.js';
import type { PersonalBudgetRegistration } from '../src/domain/personal-readonly-budget.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import { assertAnyPersonalDispatch } from '../src/policy/personal-readonly-contract.js';
import { DEFAULT_READONLY_RANGES, defaultReadonlySelection } from '../src/policy/readonly-investigation-policy.js';
import { assertReadonlyRelayDispatch, createReadonlyRelayPayload } from '../src/policy/readonly-relay-policy.js';
import { collectReadonlyRelayResponse } from '../src/policy/readonly-relay-protocol.js';
import type { ReadonlyRelayReflectionDiagnostic } from '../src/policy/readonly-relay-reflection-diagnostics.js';

// Only invented credentials and in-memory upstream responses are used. The HTTP
// client connects to the broker's loopback port; no native executable is started.
const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.broker.access', accountId: 'synthetic-broker-account' };
const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/codex',
  codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
  model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 };
type Fixture = { config: ReadonlyRelayConfig; dispatch: ReadonlyRelayDispatch; validate: ReadonlyRelayDispatchValidator };
const fixtures = new Map<'v1' | 'v2' | 'v3', Fixture>();
let directory: string | undefined;
let store: SqlitePersonalReadonlyStore | undefined;
before(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'readonly-relay-reflection-broker-'))); chmodSync(directory, 0o700);
  const source = await prepareReadonlyRepository(directory, randomUUID());
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date() };
  const synthetic = await collectReadonlyPayload(source, defaultReadonlySelection(), context);
  for (const version of ['v1', 'v2'] as const) {
    const selected: ReadonlyRelayConfig = { ...config, policyVersion: `readonly-relay-codex-${version}`, timeoutMs: 60000 };
    const payload = createReadonlyRelayPayload(synthetic, `codex-chatgpt-relay-${version}`, selected);
    fixtures.set(version, { config: selected, validate: assertReadonlyRelayDispatch,
      dispatch: { requestEnvelope: payload.requestEnvelope, requestEnvelopeHash: payload.requestEnvelopeHash, requestBodyHash: payload.requestBodyHash } });
  }
  const runtime = join(directory, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
  store = new SqlitePersonalReadonlyStore(join(runtime, 'personal-readonly.sqlite'));
  const registration: PersonalBudgetRegistration = { version: 'personal-readonly-registration-v3', collectionPolicy: 'personal-readonly-collection-v2',
    executionBudgetPolicy: 'readonly-relay-execution-budget-v1', repoId: 'reflection-synthetic', sourceRoot: source.sourceRoot, baseCommit: source.baseCommit,
    question: 'Inspect only synthetic evidence.', readRanges: DEFAULT_READONLY_RANGES.map(range => ({ ...range })), transferPaths: ['src/service.ts'] };
  const service = new PersonalReadonlyService(store, { mode: 'live', transport: 'codex-cli-relay',
    transmit: async () => { throw new Error('UNEXPECTED_MODEL_CALL'); } }, runtime, config);
  const payload = (await service.plan(registration, context)).payload!;
  fixtures.set('v3', { config, validate: assertAnyPersonalDispatch,
    dispatch: { requestEnvelope: payload.requestEnvelope, requestEnvelopeHash: payload.requestEnvelopeHash, requestBodyHash: payload.requestBodyHash } });
});
after(() => {
  store?.close();
  if (!directory) return;
  const unlock = (path: string): void => {
    if (!lstatSync(path).isDirectory()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name));
  };
  unlock(directory); rmSync(directory, { recursive: true, force: true });
});
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const escaped = (value: string): string => Array.from(value).map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const rejectedBody = '{"error":{"message":"READONLY_RELAY_BROKER_REJECTED"}}';
const send = (broker: ReadonlyRelayBroker) => fetch(`http://127.0.0.1:${broker.port}/v1/responses`, {
  method: 'POST', headers: { Authorization: `Bearer ${broker.capability}` }, body: JSON.stringify({ model: config.model, stream: true }),
});
const start = (version: 'v1' | 'v2' | 'v3', transport: ReadonlyRelayTransport) => {
  const fixture = fixtures.get(version)!;
  return startReadonlyRelayBroker(fixture.config, fixture.dispatch, async () => credential, new AbortController().signal,
    transport, () => {}, () => {}, fixture.validate);
};
const expected = (scope: ReadonlyRelayReflectionDiagnostic['scope'], match: ReadonlyRelayReflectionDiagnostic['match'],
  field: ReadonlyRelayReflectionDiagnostic['credential']): ReadonlyRelayReflectionDiagnostic =>
  ({ version: 'readonly-relay-reflection-diagnostic-v1', scope, match, credential: field });

for (const [raw, diagnostic] of [
  [sse({ text: credential.accessToken }), expected('upstream-sse', 'raw-exact', 'accessToken')],
  [`data: {"${escaped(credential.accountId)}":"synthetic"}\n\n`, expected('upstream-sse', 'decoded-exact', 'accountId')],
  [sse({ parts: [credential.accountId.slice(0, 12), 'unrelated', credential.accountId.slice(12)] }),
    expected('upstream-sse', 'ordered-fragment', 'accountId')],
] as const) {
  test(`v3 broker preserves only fixed ${diagnostic.match} categories and sends no rejected upstream body to its child`, async () => {
    let calls = 0;
    const broker = await start('v3', async () => { calls++; return new Response(Buffer.from(raw)); });
    try {
      const response = await send(broker); assert.equal(response.status, 502);
      assert.equal(await response.text(), rejectedBody);
      assert.equal(broker.result(), null); assert.equal(broker.failure(), 'READONLY_RELAY_CREDENTIAL_REFLECTION');
      assert.equal(calls, 1); assert.equal(broker.calls(), 1);
      const snapshot = broker.reflectionDiagnostic(); assert.deepEqual(snapshot, diagnostic);
      assert.equal(Object.isFrozen(snapshot), true); assert.equal(Reflect.set(snapshot!, 'match', 'raw-exact'), false);
      assert.notEqual(snapshot, broker.reflectionDiagnostic()); assert.deepEqual(broker.reflectionDiagnostic(), diagnostic);
      const repeated = await send(broker); assert.equal(repeated.status, 403); assert.equal(await repeated.text(), rejectedBody);
      assert.equal(calls, 1); assert.deepEqual(broker.reflectionDiagnostic(), diagnostic);
    } finally { await broker.close(); }
  });
}

test('v3 broker keeps its first final JSON reflection diagnostic after successful upstream relay and later failures', async () => {
  const raw = sse({ safe: 'synthetic' });
  const broker = await start('v3', async () => new Response(Buffer.from(raw)));
  try {
    const response = await send(broker); assert.equal(response.status, 200); assert.equal(await response.text(), raw);
    assert.equal(broker.reflectionDiagnostic(), null); assert.equal(broker.result()?.relayCompleted, true);
    assert.throws(() => broker.verifyFinalText(`{"answer":"${escaped(credential.accountId)}"}`), { code: 'READONLY_RELAY_CREDENTIAL_REFLECTION' });
    const diagnostic = expected('final-json', 'decoded-exact', 'accountId');
    assert.deepEqual(broker.reflectionDiagnostic(), diagnostic);
    assert.throws(() => broker.verifyFinalText(JSON.stringify({ answer: credential.accessToken })), { code: 'READONLY_RELAY_CREDENTIAL_REFLECTION' });
    assert.deepEqual(broker.reflectionDiagnostic(), diagnostic); assert.equal(broker.calls(), 1);
  } finally { await broker.close(); }
});

test('a transport replaying a genuine earlier reflection error cannot attest current broker reflection categories', async () => {
  let priorError: unknown; let priorDiagnostic: ReadonlyRelayReflectionDiagnostic | undefined;
  await assert.rejects(collectReadonlyRelayResponse(new Response(Buffer.from(sse({ text: credential.accessToken }))),
    new AbortController().signal, credential, { observeReflectionDiagnostic: value => { priorDiagnostic = value; } }),
  error => { priorError = error; return true; });
  assert.deepEqual(priorDiagnostic, expected('upstream-sse', 'raw-exact', 'accessToken'));
  const broker = await start('v3', async () => { throw priorError; });
  try {
    const response = await send(broker); assert.equal(response.status, 502); assert.equal(await response.text(), rejectedBody);
    assert.equal(broker.failure(), 'READONLY_RELAY_CREDENTIAL_REFLECTION'); assert.equal(broker.reflectionDiagnostic(), null);
    assert.equal(broker.receptionDiagnostic(), null); assert.equal(broker.result(), null); assert.equal(broker.calls(), 1);
  } finally { await broker.close(); }
});

for (const version of ['v1', 'v2'] as const) {
  test(`${version} broker preserves reflection rejection without adding the v3 diagnostic`, async () => {
    for (const scope of ['upstream-sse', 'final-json'] as const) {
      const raw = sse(scope === 'upstream-sse' ? { text: credential.accessToken } : { safe: 'synthetic' });
      const broker = await start(version, async () => new Response(Buffer.from(raw)));
      try {
        const response = await send(broker);
        if (scope === 'upstream-sse') { assert.equal(response.status, 502); assert.equal(await response.text(), rejectedBody); }
        else {
          assert.equal(response.status, 200); assert.equal(await response.text(), raw);
          assert.throws(() => broker.verifyFinalText(JSON.stringify({ text: credential.accessToken })), { code: 'READONLY_RELAY_CREDENTIAL_REFLECTION' });
        }
        assert.equal(broker.reflectionDiagnostic(), null); assert.equal(broker.calls(), 1);
      } finally { await broker.close(); }
    }
  });
}
