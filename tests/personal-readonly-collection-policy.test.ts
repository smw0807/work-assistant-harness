import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PersonalCollectionEvidence, PersonalCollectionRegistration } from '../src/domain/personal-readonly-collection.js';
import type { PersonalReadonlyRegistration, PersonalReadonlyRepository } from '../src/domain/personal-readonly.js';
import type { ReadonlyEntryIdentity } from '../src/domain/readonly-investigation.js';
import type { ReadonlyRelayConfig } from '../src/domain/readonly-relay.js';
import { derivePersonalSourceView, extractPersonalCollectionEvidence, getPersonalCollectionProfile,
  getPersonalCollectionProfileHash } from '../src/policy/personal-readonly-collection.js';
import { assertPersonalCollectionDispatch, assertPersonalCollectionPlan, createPersonalCollectionPayload, createPersonalCollectionPlan,
  getPersonalCollectionRegistrationHash, hashPersonalCollectionPlan, parsePersonalCollectionRegistration,
  parsePersonalCollectionResult, validatePersonalCollectionPayload } from '../src/policy/personal-readonly-collection-policy.js';
import { createPersonalReadonlyPayload, parsePersonalReadonlyRegistration } from '../src/policy/personal-readonly-policy.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { buildReadonlyRelayRequestEnvelope, getReadonlyRelayConfigHash, getReadonlyRelayProfileHash,
  hashReadonlyRelayEnvelope } from '../src/policy/readonly-relay-policy.js';

const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v2', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const digest = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));
const registration: PersonalCollectionRegistration = { version: 'personal-readonly-registration-v2', collectionPolicy: 'personal-readonly-collection-v2',
  repoId: 'personal-collection-test', sourceRoot: '/private/personal-collection-policy/source', baseCommit: 'a'.repeat(40),
  question: 'Explain visible request calls and checks; mark masked content as unknown.',
  readRanges: [{ path: 'src/client.ts', startLine: 2, endLine: 2 }, { path: 'src/engine.ts', startLine: 1, endLine: 2 }],
  transferPaths: ['src/client.ts', 'src/engine.ts'] };
const fakeSecret = 'SYNTHETIC_COLLECTION_SECRET_ONLY_123456';
const engineHeader = 'export const start = () => submit();\n// Visible synthetic request entry.\n';
const engine = engineHeader + '// padding\n'.repeat(3000) + '// ' + 'x'.repeat(35074 - Buffer.byteLength(engineHeader) - 33000 - 3);
const sources = { 'src/client.ts': `const authToken = "${fakeSecret}";\nexport const submit = () => ({ status: 200 });\n`, 'src/engine.ts': engine };
const fixture = (engineSource = engine, engineRange = { startLine: 1, endLine: 2 }) => {
  const normalized = parsePersonalCollectionRegistration({ ...registration, readRanges: registration.readRanges.map(range =>
    range.path === 'src/engine.ts' ? { ...range, ...engineRange } : range) });
  const selectedSources = { ...sources, 'src/engine.ts': engineSource };
  const manifest: ReadonlyEntryIdentity[] = Object.entries(selectedSources).map(([path, source], index) => ({ path, kind: 'file', hash: hashReadonlyValue(source),
    size: Buffer.byteLength(source), mode: 0o100644, device: 1, inode: index + 10, links: 1, uid: process.getuid!(), modified: '1', changed: '1' }));
  const fields: Omit<PersonalReadonlyRepository, 'identityHash'> = { id: randomUUID(), kind: 'personal-git', repoId: normalized.repoId,
    sourceRoot: normalized.sourceRoot, baseCommit: normalized.baseCommit, manifest, parents: [], gitEntries: [], headRef: 'refs/heads/main',
    readAllowedFiles: Object.keys(sources), sourceManifestHash: digest(manifest.map(({ path, hash, size, mode }) => ({ path, hash, size, mode }))) };
  const repository = { ...fields, identityHash: digest(fields) };
  const views = Object.entries(selectedSources).map(([path, source]) => derivePersonalSourceView(path, Buffer.from(source)));
  const collected: PersonalCollectionEvidence = { evidence: normalized.readRanges.map((range) =>
    extractPersonalCollectionEvidence(repository.repoId, repository.baseCommit, range, views.find((view) => view.path === range.path)!)),
  sourceViews: views.map(({ bytes: _bytes, ...proof }) => proof) };
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date() };
  const payload = createPersonalCollectionPayload(repository, normalized, collected, context, config);
  const plan = createPersonalCollectionPlan(payload, context, config);
  return { repository, collected, context, payload, plan };
};
const oldRegistration = (): PersonalReadonlyRegistration => {
  return { version: 'personal-readonly-registration-v1', repoId: registration.repoId, sourceRoot: registration.sourceRoot,
    baseCommit: registration.baseCommit, question: registration.question, readRanges: registration.readRanges, transferPaths: registration.transferPaths };
};
const dispatch = (body: string) => {
  const requestEnvelope = buildReadonlyRelayRequestEnvelope(body, 'codex-chatgpt-relay-v2', config);
  return { requestEnvelope, requestBodyHash: hashReadonlyValue(body), requestEnvelopeHash: hashReadonlyRelayEnvelope(requestEnvelope) };
};
interface WireInput {
  collection: { viewNotices: { sourceHash?: string; viewHash: string; redacted: boolean }[];
    profile: { limits: { sourceFileBytes: number } }; evidenceOrigin: string };
  repository: { sourceRoot?: string };
}

test('collection payload and dispatch preserve selected trailing blank lines and an entirely blank excerpt', () => {
  for (const [source, endLine, excerpt] of [['visible();\n\n', 2, 'visible();\n'], ['visible();\n\n\n', 3, 'visible();\n\n'], ['\n', 1, '']] as const) {
    const h = fixture(source, { startLine: 1, endLine });
    assert.equal(h.payload.context.evidence.find(item => item.path === 'src/engine.ts')!.excerpt, excerpt);
    validatePersonalCollectionPayload(h.plan, h.payload, config);
    assertPersonalCollectionDispatch(dispatch(h.payload.requestBody), config);
  }
});

test('collection registration is separate from v1 and binds its explicit source policy', () => {
  const parsed = parsePersonalCollectionRegistration({ ...registration, readRanges: [...registration.readRanges].reverse() });
  assert.deepEqual(parsed, registration); assert.equal(getPersonalCollectionRegistrationHash(parsed), digest(parsed));
  assert.throws(() => parsePersonalCollectionRegistration(oldRegistration())); assert.throws(() => parsePersonalReadonlyRegistration(registration));
  for (const change of [{ collectionPolicy: 'personal-readonly-collection-v3' }, { sourceFileBytes: 1048576 }, { version: 'personal-readonly-registration-v1' }]) {
    assert.throws(() => parsePersonalCollectionRegistration({ ...registration, ...change }));
  }
});

test('explicit source64K/full-view64K/excerpt32K contract accepts a 35074-byte file without changing relay-v2 limits or old-v1 behavior', () => {
  const h = fixture(); assert.equal(Buffer.byteLength(engine), 35074);
  assert.equal(h.plan.collectionProfile.limits.sourceFileBytes, 65536); assert.equal(h.plan.collectionProfile.limits.fullViewBytes, 65536);
  assert.equal(h.plan.collectionProfile.limits.excerptBytes, 32768); assert.equal(h.plan.collectionProfile.relayProfileScope, 'unchanged-transport-component');
  assert.equal(h.plan.limits.fileBytes, 32768); assert.equal(h.plan.limits.responseBytes, 4194304); assert.equal(h.plan.limits.outputBytes, 16384);
  assert.equal(h.plan.collectionProfileHash, getPersonalCollectionProfileHash()); assert.deepEqual(h.plan.collectionProfile, getPersonalCollectionProfile());
  assert.equal(h.plan.connectionProfileHash, '6d29d24deba28e2a1fd6058c6fb389a148da7f6150ff8edd9dbfd1bc1f52eca7');
  assert.equal(h.plan.configHash, '3d949087e8ba392a3d6fc855b15a5d9730a7d16f72b9c22f03db823333ca033c');
  assert.equal(getReadonlyRelayProfileHash(h.plan.profileId, config), h.plan.connectionProfileHash);
  assert.equal(getReadonlyRelayConfigHash(h.plan.profileId, config), h.plan.configHash);
  assert.throws(() => createPersonalReadonlyPayload(h.repository, oldRegistration(), h.collected.evidence, h.context, config));
});

test('raw rejection and whole-view passage remain distinct while only view hashes and masking notices enter model input', () => {
  const h = fixture(); validatePersonalCollectionPayload(h.plan, h.payload, config); assertPersonalCollectionDispatch(dispatch(h.payload.requestBody), config);
  const client = h.payload.sourceViews[0]!; assert.equal(client.rawSensitiveCheck, 'rejected'); assert.equal(client.viewSensitiveCheck, 'passed');
  assert.ok(client.maskCount > 0); assert.equal(client.maskedLines.length, client.maskCount); assert.equal(client.sourceLines, client.viewLines);
  assert.notEqual(client.sourceHash, client.viewHash); assert.equal(h.payload.context.evidence[0]!.fileHash, client.viewHash);
  const input = JSON.parse(h.payload.inputText); assert.equal(input.collection.evidenceOrigin, 'line-preserving-derived-view');
  assert.equal(input.collection.fileHashMeaning, 'full-safe-view-sha256'); assert.equal(input.collection.sourceViewsHash, h.plan.sourceViewsHash);
  assert.equal(input.collection.viewNotices[0].redacted, true); assert.equal(input.collection.viewNotices[0].viewHash, client.viewHash);
  for (const text of [h.payload.inputText, h.payload.requestBody, JSON.stringify(h.plan), JSON.stringify(h.payload)]) assert.equal(text.includes(fakeSecret), false);
  for (const text of [h.payload.inputText, h.payload.requestBody, JSON.stringify(h.plan)]) {
    assert.equal(text.includes(registration.sourceRoot), false); assert.equal(text.includes('"sourceHash"'), false); assert.equal(text.includes(client.sourceHash), false);
  }
  assert.equal(Object.hasOwn(h.payload.sourceViews[0]!, 'bytes'), false); assert.equal(h.plan.sourceViewsHash, digest(h.payload.sourceViews));
});

test('source and view provenance, rejection metadata, line preservation and finite limits cannot be tampered behind public hashes', () => {
  const h = fixture();
  const changes: ((value: PersonalCollectionEvidence) => void)[] = [
    (value) => { value.sourceViews[0]!.sourceHash = 'b'.repeat(64); },
    (value) => { value.sourceViews[0]!.viewHash = 'b'.repeat(64); },
    (value) => { value.sourceViews[0]!.sourceBytes = 65537; },
    (value) => { value.sourceViews[0]!.viewBytes = 65537; },
    (value) => { value.sourceViews[0]!.sourceLines++; },
    (value) => { value.sourceViews[0]!.rawSensitiveCheck = 'passed'; },
    (value) => { value.sourceViews[1]!.rawSensitiveCheck = 'rejected'; },
    (value) => { value.sourceViews[0]!.maskCount = 129; },
    (value) => { value.sourceViews[0]!.maskedLines[0]!.endLine = 1000; },
    (value) => { value.sourceViews.pop(); },
    (value) => { Object.assign(value.sourceViews[0]!, { sourceText: 'must never persist' }); },
  ];
  for (const change of changes) {
    const collected = structuredClone(h.collected); change(collected);
    assert.throws(() => createPersonalCollectionPayload(h.repository, registration, collected, h.context, config));
  }
  const payload = structuredClone(h.payload); payload.sourceViewsHash = 'b'.repeat(64);
  assert.throws(() => validatePersonalCollectionPayload(h.plan, payload, config));
  const changed = structuredClone(h.plan); changed.collectionProfile.limits.sourceFileBytes = 131072 as 65536; changed.planHash = hashPersonalCollectionPlan(changed);
  assert.throws(() => assertPersonalCollectionPlan(changed, config));
});

test('evidence fileHash means the complete safe view, never the rejected raw source', () => {
  const h = fixture(); const collected = structuredClone(h.collected); const item = collected.evidence[0]!;
  item.fileHash = collected.sourceViews[0]!.sourceHash;
  const { evidenceId, ...fields } = item; assert.match(evidenceId, /^evidence-/u); item.evidenceId = 'evidence-' + digest(fields);
  assert.throws(() => createPersonalCollectionPayload(h.repository, registration, collected, h.context, config));
  const wrong = structuredClone(h.plan); wrong.sourceViewsHash = 'b'.repeat(64); wrong.planHash = hashPersonalCollectionPlan(wrong);
  assert.throws(() => validatePersonalCollectionPayload(wrong, h.payload, config));
});

test('collection dispatch rejects origin, profile, view hash, private fields and masking notice tampering', () => {
  const h = fixture();
  for (const change of [
    (input: WireInput) => { input.collection.viewNotices[0]!.sourceHash = h.payload.sourceViews[0]!.sourceHash; },
    (input: WireInput) => { input.collection.viewNotices[0]!.viewHash = 'b'.repeat(64); },
    (input: WireInput) => { input.collection.viewNotices[0]!.redacted = false; },
    (input: WireInput) => { input.collection.profile.limits.sourceFileBytes = 1048576; },
    (input: WireInput) => { input.collection.evidenceOrigin = 'original-source'; },
    (input: WireInput) => { input.repository.sourceRoot = registration.sourceRoot; },
  ]) {
    const body = JSON.parse(h.payload.requestBody); const input = JSON.parse(body.input[0].content[0].text); change(input);
    body.input[0].content[0].text = canonicalReadonlyJson(input);
    assert.throws(() => assertPersonalCollectionDispatch(dispatch(canonicalReadonlyJson(body)), config));
  }
});

test('collection results keep evidence-only schema, secret and execution-field rejection', () => {
  const h = fixture(); const evidence = h.payload.context.evidence[0]!;
  const output = { classification: 'question', summary: 'The visible client function returns a status.', facts: [{ text: 'submit returns status 200.',
    references: [{ evidenceId: evidence.evidenceId, startLine: 2, endLine: 2 }] }], hypotheses: [], answerDraft: 'Only visible lines support this conclusion.',
  questions: [], suggestions: [], limitations: ['Masked configuration is unknown; no target code was executed.'] };
  assert.equal(parsePersonalCollectionResult(JSON.stringify(output), h.payload).mode, 'live');
  for (const value of [{ ...output, command: 'npm test' }, { ...output, summary: `Bearer ${fakeSecret}` },
    { ...output, facts: [{ ...output.facts[0], references: [{ evidenceId: evidence.evidenceId, startLine: 1, endLine: 2 }] }] }]) {
    assert.throws(() => parsePersonalCollectionResult(JSON.stringify(value), h.payload));
  }
});

test('the existing personal-v1 policy and registration example stay byte-identical', () => {
  assert.equal(hashReadonlyValue(readFileSync(join(process.cwd(), 'src/policy/personal-readonly-policy.ts'))), '17b1d2e4c0b0e66dd271116e854b6a1253f3e1fbb5eb44547cc2386a2f62b35f');
  assert.equal(hashReadonlyValue(readFileSync(join(process.cwd(), 'config/personal-readonly.example.json'))), '019f776c57e6bd9a5823453c4c2bf15794edcb6dc0ed32d285d3c1a7ad987937');
  const example = parsePersonalCollectionRegistration(JSON.parse(readFileSync(join(process.cwd(), 'config/personal-readonly-collection.example.json'), 'utf8')));
  assert.equal(example.collectionPolicy, 'personal-readonly-collection-v2'); assert.equal(example.version, 'personal-readonly-registration-v2');
});
