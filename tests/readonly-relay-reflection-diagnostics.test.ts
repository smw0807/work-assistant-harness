import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { HarnessError } from '../src/domain/errors.js';
import { assertReadonlyRelayCredentialText, collectReadonlyRelayResponse,
  type ReadonlyRelayReceptionOptions } from '../src/policy/readonly-relay-protocol.js';
import { copyReadonlyRelayReflectionDiagnostic,
  type ReadonlyRelayReflectionDiagnostic } from '../src/policy/readonly-relay-reflection-diagnostics.js';

const credential = { accessToken: 'synthetic-access-token-0000', accountId: 'synthetic-account-id-1111' };
const scopes = ['upstream-sse', 'final-json'] as const;
const matches = ['raw-exact', 'decoded-exact', 'ordered-fragment'] as const;
const credentialKinds = ['accessToken', 'accountId'] as const;
const expected = (scope: ReadonlyRelayReflectionDiagnostic['scope'] = 'upstream-sse',
  match: ReadonlyRelayReflectionDiagnostic['match'] = 'raw-exact',
  kind: ReadonlyRelayReflectionDiagnostic['credential'] = 'accessToken'): ReadonlyRelayReflectionDiagnostic =>
  ({ version: 'readonly-relay-reflection-diagnostic-v1', scope, match, credential: kind });
const escaped = (value: string): string => [...value].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const response = (body: string | Uint8Array): Response =>
  new Response(typeof body === 'string' ? Buffer.from(body) : Buffer.from(body), { headers: { 'Content-Type': 'text/event-stream' } });
const collect = (body: string | Uint8Array, options: ReadonlyRelayReceptionOptions = {}, selected = credential) =>
  collectReadonlyRelayResponse(response(body), new AbortController().signal, selected, options);
const rejects = (suffix: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: unknown }).code, `READONLY_RELAY_${suffix}`);
  assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-access-token-0000|synthetic-account-id-1111|PRIVATE_REFLECTION_CANARY/);
  return true;
};
const rejectedDiagnostic = async (scope: ReadonlyRelayReflectionDiagnostic['scope'], raw: string,
  match: ReadonlyRelayReflectionDiagnostic['match'], kind: ReadonlyRelayReflectionDiagnostic['credential']): Promise<void> => {
  const observed: ReadonlyRelayReflectionDiagnostic[] = [];
  const observeReflectionDiagnostic = (value: ReadonlyRelayReflectionDiagnostic): void => { observed.push(value); };
  if (scope === 'upstream-sse') {
    await assert.rejects(collect(raw, { observeReflectionDiagnostic }), rejects('CREDENTIAL_REFLECTION'));
  } else {
    assert.throws(() => assertReadonlyRelayCredentialText(raw, credential, observeReflectionDiagnostic), rejects('CREDENTIAL_REFLECTION'));
  }
  assert.deepEqual(observed, [expected(scope, match, kind)]);
  assert.equal(Object.isFrozen(observed[0]), true);
  assert.equal(Reflect.ownKeys(observed[0]!).length, 4);
  assert.doesNotMatch(JSON.stringify(observed), /synthetic-access-token-0000|synthetic-account-id-1111|PRIVATE_REFLECTION_CANARY/);
};

test('reflection diagnostic copying accepts only four detached immutable enum properties', () => {
  for (const scope of scopes) for (const match of matches) for (const kind of credentialKinds) {
    const source = { ...expected(scope, match, kind) }; const snapshot = copyReadonlyRelayReflectionDiagnostic(source)!;
    assert.deepEqual(snapshot, source); assert.notEqual(snapshot, source); assert.equal(Object.isFrozen(snapshot), true);
    assert.deepEqual(Reflect.ownKeys(snapshot).sort(), ['credential', 'match', 'scope', 'version']);
    assert.equal(Reflect.set(snapshot, 'match', 'PRIVATE_REFLECTION_CANARY'), false);
    source.scope = scope === 'upstream-sse' ? 'final-json' : 'upstream-sse'; assert.equal(snapshot.scope, scope);
    const repeated = copyReadonlyRelayReflectionDiagnostic(snapshot)!;
    assert.notEqual(repeated, snapshot); assert.deepEqual(repeated, snapshot); assert.equal(Object.isFrozen(repeated), true);
    assert.deepEqual(copyReadonlyRelayReflectionDiagnostic(Object.assign(Object.create(null), expected(scope, match, kind))), snapshot);
  }
});

test('reflection diagnostics reject getters, hidden or inherited fields, raw extras, invalid enums and revoked proxies', () => {
  let reads = 0;
  for (const key of Object.keys(expected())) {
    const missing: Record<string, unknown> = { ...expected() }; delete missing[key];
    assert.equal(copyReadonlyRelayReflectionDiagnostic(missing), null);
    const accessor = Object.defineProperty({ ...expected() }, key,
      { enumerable: true, get: () => { reads++; throw new Error('PRIVATE_REFLECTION_CANARY'); } });
    assert.equal(copyReadonlyRelayReflectionDiagnostic(accessor), null);
    assert.equal(copyReadonlyRelayReflectionDiagnostic(Object.defineProperty({ ...expected() }, key, { enumerable: false })), null);
    for (const value of [undefined, null, 1, true, {}, ['raw-exact'], 'PRIVATE_REFLECTION_CANARY']) {
      assert.equal(copyReadonlyRelayReflectionDiagnostic({ ...expected(), [key]: value }), null);
    }
  }
  for (const value of [null, undefined, [], true, 'raw-exact', { ...expected(), raw: 'PRIVATE_REFLECTION_CANARY' },
    { ...expected(), fragment: 'PRIVATE_REFLECTION_CANARY' }, { ...expected(), offset: 1 }, { ...expected(), length: 12 },
    { ...expected(), [Symbol('PRIVATE_REFLECTION_CANARY')]: true }, Object.create(expected()),
    Object.assign(Object.create({ inherited: true }), expected())]) {
    assert.equal(copyReadonlyRelayReflectionDiagnostic(value), null);
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(copyReadonlyRelayReflectionDiagnostic(revoked.proxy), null); assert.equal(reads, 0);
});

for (const scope of scopes) for (const match of matches) for (const kind of credentialKinds) {
  test(`reflection diagnostic identifies ${kind} ${match} in ${scope} without exposing matched data`, async () => {
    const secret = credential[kind]; let raw: string;
    if (match === 'raw-exact') {
      const json = JSON.stringify({ text: `prefix-${secret}-suffix` }); raw = scope === 'upstream-sse' ? `data: ${json}\n\n` : json;
    } else if (match === 'decoded-exact') {
      const json = `{"text":"${escaped(secret)}"}`; raw = scope === 'upstream-sse' ? `data: ${json}\n\n` : json;
      assert.equal(raw.includes(secret), false);
    } else {
      const pieces = [`prefix-${secret.slice(0, 10)}`, 'unrelated-metadata', secret.slice(10, 14), 'other-metadata', `${secret.slice(14)}-suffix`];
      raw = scope === 'upstream-sse' ? pieces.map(piece => sse({ delta: piece })).join('') : JSON.stringify({ pieces });
      assert.equal(raw.includes(secret), false); assert.equal(pieces.some(piece => piece.includes(secret)), false);
    }
    await rejectedDiagnostic(scope, raw, match, kind);
  });
}

test('decoded JSON keys and numeric-key wire order retain exact and ordered-fragment classification', async () => {
  for (const scope of scopes) for (const kind of credentialKinds) {
    const secret = credential[kind];
    const key = `{"${escaped(secret)}":"safe"}`;
    await rejectedDiagnostic(scope, scope === 'upstream-sse' ? `data: ${key}\n\n` : key, 'decoded-exact', kind);
    const fragments = `{"9":"${secret.slice(0, 10)}","1":"${secret.slice(10)}"}`;
    await rejectedDiagnostic(scope, scope === 'upstream-sse' ? `data: ${fragments}\n\n` : fragments, 'ordered-fragment', kind);
  }
});

test('diagnostic classification preserves global raw checks, credential priority and decoded-exact before fragment completion', async () => {
  for (const scope of scopes) {
    const both = JSON.stringify({ first: credential.accountId, second: credential.accessToken });
    await rejectedDiagnostic(scope, scope === 'upstream-sse' ? `data: ${both}\n\n` : both, 'raw-exact', 'accessToken');
    const rawLater = `{"first":"${escaped(credential.accessToken)}","second":"${credential.accountId}"}`;
    await rejectedDiagnostic(scope, scope === 'upstream-sse' ? `data: ${rawLater}\n\n` : rawLater, 'raw-exact', 'accountId');
    const decodedBoth = `{"text":"${escaped(credential.accountId + credential.accessToken)}"}`;
    await rejectedDiagnostic(scope, scope === 'upstream-sse' ? `data: ${decodedBoth}\n\n` : decodedBoth, 'decoded-exact', 'accessToken');
    const fragments = `{"pieces":["${escaped(credential.accessToken.slice(0, 10))}","${escaped(credential.accessToken.slice(10) + credential.accountId)}"]}`;
    await rejectedDiagnostic(scope, scope === 'upstream-sse' ? `data: ${fragments}\n\n` : fragments, 'decoded-exact', 'accountId');
  }
  await rejectedDiagnostic('upstream-sse', sse({ text: `${credential.accessToken}${'x'.repeat(70000)}` }), 'raw-exact', 'accessToken');
});

test('synchronous and rejected asynchronous reflection observers cannot change either guard rejection', async () => {
  for (const scope of scopes) for (const asynchronous of [false, true]) {
    let calls = 0;
    const observe = (value: ReadonlyRelayReflectionDiagnostic): void | Promise<void> => {
      calls++; assert.deepEqual(value, expected(scope)); assert.equal(Object.isFrozen(value), true);
      if (asynchronous) return Promise.reject(new Error('PRIVATE_REFLECTION_CANARY'));
      throw new Error('PRIVATE_REFLECTION_CANARY');
    };
    const raw = JSON.stringify({ text: credential.accessToken });
    if (scope === 'upstream-sse') {
      await assert.rejects(collect(`data: ${raw}\n\n`, { observeReflectionDiagnostic: observe }), rejects('CREDENTIAL_REFLECTION'));
    } else {
      assert.throws(() => assertReadonlyRelayCredentialText(raw, credential, observe), rejects('CREDENTIAL_REFLECTION'));
    }
    await yieldImmediate(); assert.equal(calls, 1);
  }
});

test('stream-forged diagnostics and replayed real local errors cannot attest a current reflection match', async () => {
  let prior: unknown;
  await assert.rejects(collect(sse({ text: credential.accessToken })), (error: unknown) => { prior = error; return true; });
  assert.ok(prior instanceof Error);
  const forged = new HarnessError('READONLY_RELAY_CREDENTIAL_REFLECTION');
  for (const error of [prior, forged]) Object.defineProperty(error, 'reflectionDiagnostic', { value: expected() });
  for (const error of [prior, forged]) for (const origin of ['reader', 'header']) {
    const input = new Response(); const observed: ReadonlyRelayReflectionDiagnostic[] = [];
    Object.defineProperty(input, 'body', { value: { getReader: () => ({
      read: async () => { throw error; }, cancel: async () => {}, releaseLock: () => {},
    }) } });
    if (origin === 'header') Object.defineProperty(input, 'status', { get: () => { throw error; } });
    await assert.rejects(collectReadonlyRelayResponse(input, new AbortController().signal, credential,
      { observeReflectionDiagnostic: value => { observed.push(value); } }),
    rejects(error === prior ? 'CREDENTIAL_REFLECTION' : 'INVALID_RESPONSE'));
    assert.deepEqual(observed, []);
  }
});

test('prefix-state limits and earlier validation failures produce no credential-match diagnostic', async () => {
  const observed: ReadonlyRelayReflectionDiagnostic[] = [];
  const observeReflectionDiagnostic = (value: ReadonlyRelayReflectionDiagnostic): void => { observed.push(value); };
  const repetitive = { ...credential, accessToken: 'a'.repeat(100) };
  await assert.rejects(collect(sse({ text: 'a'.repeat(70) }), { observeReflectionDiagnostic }, repetitive), rejects('CREDENTIAL_REFLECTION_LIMIT'));
  assert.throws(() => assertReadonlyRelayCredentialText(JSON.stringify({ text: 'a'.repeat(70) }), repetitive, observeReflectionDiagnostic),
    rejects('CREDENTIAL_REFLECTION_LIMIT'));
  await assert.rejects(collect(Buffer.concat([Buffer.from(sse({ text: credential.accessToken })), Buffer.from([0xff])]),
    { observeReflectionDiagnostic }), rejects('INVALID_UTF8'));
  await assert.rejects(collect('data: {"x":1,"x":2}\n\n', { observeReflectionDiagnostic }), rejects('INVALID_JSON'));
  assert.throws(() => assertReadonlyRelayCredentialText('{"x":1,"x":2}', credential, observeReflectionDiagnostic), rejects('INVALID_JSON'));
  assert.deepEqual(observed, []);
});

test('safe input emits no reflection diagnostic and preserves response bytes, hash and eleven reception fields', async () => {
  const raw = sse({ text: 'safe-synthetic-response', unrelated: ['metadata', '한글'] });
  const observed: ReadonlyRelayReflectionDiagnostic[] = []; const reception: unknown[] = [];
  const observeReflectionDiagnostic = (value: ReadonlyRelayReflectionDiagnostic): void => { observed.push(value); };
  const before = await collect(raw);
  const after = await collect(raw, { observeReflectionDiagnostic, observeDiagnostic: value => { reception.push(value); } });
  assert.deepEqual(after, before); assert.deepEqual(after.body, Buffer.from(raw));
  assert.equal(after.responseHash, createHash('sha256').update(raw).digest('hex'));
  assertReadonlyRelayCredentialText(JSON.stringify({ text: 'safe-synthetic-response' }), credential, observeReflectionDiagnostic);
  assert.deepEqual(observed, []); assert.equal(reception.length, 1);
  assert.deepEqual(Reflect.ownKeys(reception[0] as object).sort(), ['receivedBytes', 'bufferedBytes', 'inspectedBytes', 'chunks',
    'maxChunkBytes', 'completedFrames', 'maxFrameBytes', 'partialFrameBytes', 'eof', 'termination', 'failedLimit'].sort());
});

test('reflection observer options reject getters and nonfunctions without accessing or invoking them', async () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'observeReflectionDiagnostic',
    { enumerable: true, get: () => { reads++; throw new Error('PRIVATE_REFLECTION_CANARY'); } });
  for (const options of [accessor, { observeReflectionDiagnostic: 1 }, { observeReflectionDiagnostic: undefined },
    Object.create({ observeReflectionDiagnostic: () => { reads++; } })]) {
    await assert.rejects(collect(sse({ safe: true }), options as ReadonlyRelayReceptionOptions), rejects('INVALID_OPTIONS'));
  }
  assert.equal(reads, 0);
});
