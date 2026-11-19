import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectReadonlyRelayResponse } from '../src/policy/readonly-relay-protocol.js';
import type { ReadonlyRelayReceptionDiagnostic } from '../src/policy/readonly-relay-reception-diagnostics.js';

type CredentialField = 'accessToken' | 'accountId';
type SyntheticCredential = Record<CredentialField, string>;

// These credentials and frames are invented. A synthetic collision does not establish
// which string or matching branch caused a past real response to be rejected.
const collisionCredential = 'a1b2c3d4e5f6';
const credentialFor = (field: CredentialField): SyntheticCredential => ({
  accessToken: 'SYNTHETIC_ACCESS_TOKEN_UNUSED',
  accountId: 'SYNTHETIC_ACCOUNT_ID_UNUSED',
  [field]: collisionCredential,
});
const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const escapeCharacters = (value: string): string => Array.from(value)
  .map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const collect = (raw: string, credential: SyntheticCredential, observeDiagnostic?: (value: ReadonlyRelayReceptionDiagnostic) => void) =>
  collectReadonlyRelayResponse(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }),
    new AbortController().signal, credential, observeDiagnostic ? { observeDiagnostic } : undefined);

const separatedFrames = (pieces: readonly string[]): Record<string, string>[] => pieces.flatMap<Record<string, string>>((piece, index) => [
  ...Array.from({ length: 80 }, () => ({ kind: 'unrelated', message: 'ordinary filler' })),
  index % 2 === 0 ? { [piece]: 'idle' } : { marker: piece },
]);
const assertNoCompleteCredential = (frames: Record<string, string>[], credential: SyntheticCredential): string => {
  const raw = frames.map(frame).join('');
  for (const secret of Object.values(credential)) {
    assert.equal(raw.includes(secret), false);
    for (const value of frames) for (const text of [...Object.keys(value), ...Object.values(value)]) {
      assert.equal(text.includes(secret), false);
    }
  }
  return raw;
};

for (const field of ['accessToken', 'accountId'] as const) {
  test(`conservative reflection guard accumulates unrelated one-character ${field} fragments across distant SSE keys and values`, async () => {
    const credential = credentialFor(field);
    const frames = separatedFrames(Array.from(collisionCredential));
    const raw = assertNoCompleteCredential(frames, credential);
    let observed: ReadonlyRelayReceptionDiagnostic | undefined;

    // The same scanner retains partial matches across unrelated strings and frames.
    // All bytes are received at EOF; rejection is not a response or frame limit.
    await assert.rejects(collect(raw, credential, value => { observed = value; }),
      { code: 'READONLY_RELAY_CREDENTIAL_REFLECTION' });
    assert.equal(observed!.completedFrames, frames.length);
    assert.equal(observed!.receivedBytes, Buffer.byteLength(raw));
    assert.equal(observed!.eof, true);
    assert.equal(observed!.termination, 'credential-reflection');
    assert.equal(observed!.failedLimit, 'none');
  });

  test(`reflection guard still rejects a complete raw ${field} in an SSE comment`, async () => {
    const credential = credentialFor(field);
    const raw = `: ${collisionCredential}\n${frame({ safe: true })}`;
    await assert.rejects(collect(raw, credential), { code: 'READONLY_RELAY_CREDENTIAL_REFLECTION' });
  });

  test(`reflection guard still rejects a complete escaped ${field} in decoded JSON keys and values`, async () => {
    const credential = credentialFor(field);
    const escaped = escapeCharacters(collisionCredential);
    for (const raw of [`data: {"value":"${escaped}"}\n\n`, `data: {"${escaped}":"ordinary"}\n\n`]) {
      assert.equal(raw.includes(collisionCredential), false);
      await assert.rejects(collect(raw, credential), { code: 'READONLY_RELAY_CREDENTIAL_REFLECTION' });
    }
  });

  test(`reflection guard still rejects intentional consecutive ${field} fragments`, async () => {
    const credential = credentialFor(field);
    const pieces = ['a1b', '2c3', 'd4e', '5f6'];
    assert.equal(pieces.join(''), collisionCredential);
    const raw = frame({ fragments: pieces });
    assert.equal(raw.includes(collisionCredential), false);
    await assert.rejects(collect(raw, credential), { code: 'READONLY_RELAY_CREDENTIAL_REFLECTION' });
  });

  test(`reflection guard accepts separated ${field} fragments that never complete a match`, async () => {
    const credential = credentialFor(field);
    const frames = separatedFrames(Array.from(collisionCredential.slice(0, -1)));
    const raw = assertNoCompleteCredential(frames, credential);
    let observed: ReadonlyRelayReceptionDiagnostic | undefined;
    const result = await collect(raw, credential, value => { observed = value; });
    assert.equal(result.body.toString('utf8'), raw);
    assert.equal(observed!.completedFrames, frames.length);
    assert.equal(observed!.termination, 'eof');
    assert.equal(observed!.failedLimit, 'none');
  });

  test(`reflection guard accepts disjoint ${field} fragments presented only in reverse order`, async () => {
    const credential = credentialFor(field);
    const raw = frame({ fragments: ['5f6', 'd4e', '2c3', 'a1b'] });
    const result = await collect(raw, credential);
    assert.equal(result.body.toString('utf8'), raw);
  });
}
