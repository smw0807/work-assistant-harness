import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import type { PersonalReadonlyRegistration, PersonalReadonlyRepository } from '../src/domain/personal-readonly.js';
import type { ReadonlyEntryIdentity, ReadonlyEvidence } from '../src/domain/readonly-investigation.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import { assertPersonalReadonlyDispatch, assertPersonalReadonlyPlan, createPersonalReadonlyPayload, createPersonalReadonlyPlan,
  getPersonalReadonlyRegistrationHash, hashPersonalReadonlyPlan, parsePersonalReadonlyRegistration,
  parsePersonalReadonlyResult, validatePersonalReadonlyPayload } from '../src/policy/personal-readonly-policy.js';
import { canonicalReadonlyJson, createReadonlyEvidence, defaultReadonlySelection, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { buildReadonlyRelayRequestEnvelope, createReadonlyRelayPayload, getReadonlyRelayConfigHash,
  getReadonlyRelayProfileHash, hashReadonlyRelayEnvelope } from '../src/policy/readonly-relay-policy.js';

const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v2', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const context = () => ({ ownerId: `os-user:${process.getuid!()}`, now: new Date() });
const digest = (value: unknown) => hashReadonlyValue(canonicalReadonlyJson(value));
const registration: PersonalReadonlyRegistration = { version: 'personal-readonly-registration-v1', repoId: 'personal-test',
  sourceRoot: '/private/personal-policy-test/source', baseCommit: 'a'.repeat(40), question: 'Explain the selected request flow and checks.',
  readRanges: [{ path: 'src/main.ts', startLine: 1, endLine: 2 }, { path: 'src/submit.ts', startLine: 1, endLine: 2 }],
  transferPaths: ['src/main.ts', 'src/submit.ts'] };
const files = { 'src/main.ts': "import { submit } from './submit';\nexport const main = () => submit();\n",
  'src/submit.ts': 'export const submit = () => ({ status: 200 });\n// Selected local source, never executed by the policy test.\n' };
const fixture = (selectedRegistration = registration) => {
  const normalized = parsePersonalReadonlyRegistration(selectedRegistration);
  const manifest: ReadonlyEntryIdentity[] = Object.entries(files).map(([path, text], index) => ({ path, kind: 'file', hash: hashReadonlyValue(text),
    size: Buffer.byteLength(text), mode: 0o100444, device: 1, inode: index + 10, links: 1, uid: process.getuid!(), modified: '1', changed: '1' }));
  const fields: Omit<PersonalReadonlyRepository, 'identityHash'> = { id: randomUUID(), kind: 'personal-git', repoId: normalized.repoId,
    sourceRoot: normalized.sourceRoot, baseCommit: normalized.baseCommit, manifest, parents: [], gitEntries: [], headRef: 'refs/heads/main',
    readAllowedFiles: normalized.readRanges.map((item) => item.path),
    sourceManifestHash: digest(manifest.map(({ path, hash, size, mode }) => ({ path, hash, size, mode }))) };
  const repository = { ...fields, identityHash: digest(fields) };
  const evidence: ReadonlyEvidence[] = normalized.readRanges.map((range) => createReadonlyEvidence(repository.repoId, repository.baseCommit,
    range, Buffer.from(files[range.path as keyof typeof files])));
  const now = context(); const payload = createPersonalReadonlyPayload(repository, normalized, evidence, now, config);
  const plan = createPersonalReadonlyPlan(payload, now, config);
  return { repository, evidence, now, payload, plan };
};
const dispatch = (body: string): ReadonlyRelayDispatch => {
  const requestEnvelope = buildReadonlyRelayRequestEnvelope(body, 'codex-chatgpt-relay-v2', config);
  return { requestEnvelope, requestBodyHash: hashReadonlyValue(body), requestEnvelopeHash: hashReadonlyRelayEnvelope(requestEnvelope) };
};

test('personal registration normalizes explicit ranges and binds private registration data only by hash', () => {
  const parsed = parsePersonalReadonlyRegistration({ ...registration,
    readRanges: [...registration.readRanges].reverse(), transferPaths: [...registration.transferPaths].reverse() });
  assert.deepEqual(parsed, registration); assert.equal(getPersonalReadonlyRegistrationHash(parsed), digest(parsed));
  const changed = { ...parsed, sourceRoot: '/private/different-personal-source' };
  assert.notEqual(getPersonalReadonlyRegistrationHash(changed), getPersonalReadonlyRegistrationHash(parsed));
});

test('registration rejects secret paths, traversal, scope widening, invalid question and non-data properties without invoking getters', () => {
  let reads = 0;
  const inheritedArray = Object.setPrototypeOf([...registration.readRanges], Object.defineProperty({}, 'map', {
    get() { reads++; throw new Error('must not run'); },
  }));
  const bad = [{ ...registration, sourceRoot: '../relative' }, { ...registration, sourceRoot: '/' },
    { ...registration, question: 'x'.repeat(4097) }, { ...registration, question: registration.sourceRoot },
    { ...registration, question: 'Bearer SYNTHETIC_PRIVATE_CANARY_1234' },
    { ...registration, readRanges: [{ path: '.env', startLine: 1, endLine: 1 }] },
    { ...registration, readRanges: [{ path: '../escape.ts', startLine: 1, endLine: 1 }] },
    { ...registration, readRanges: [{ path: 'src/main.ts', startLine: 1, endLine: 201 }] },
    { ...registration, transferPaths: ['unselected.ts'] }, { ...registration, transferPaths: ['src/main.ts', 'src/main.ts'] },
    { ...registration, command: 'npm test' }, { ...registration, [Symbol('private')]: true },
    Object.assign(Object.create({ inherited: true }), registration), { ...registration, readRanges: inheritedArray },
    Object.defineProperty({ ...registration }, 'question', { enumerable: true, get() { reads++; return 'must not run'; } })];
  for (const value of bad) assert.throws(() => parsePersonalReadonlyRegistration(value), { code: 'PERSONAL_READONLY_INVALID_REGISTRATION' });
  assert.equal(reads, 0);
});

test('personal payload and plan expose selected evidence while preserving the exact relay-v2 profile and limits', () => {
  const h = fixture({ ...registration, transferPaths: ['src/main.ts'] });
  assertPersonalReadonlyPlan(h.plan, config); validatePersonalReadonlyPayload(h.plan, h.payload, config);
  assertPersonalReadonlyDispatch(dispatch(h.payload.requestBody), config);
  assert.equal(h.plan.policy, 'personal-readonly-investigation-v1'); assert.equal(h.plan.inputPolicyVersion, 'personal-readonly-input-v1');
  assert.equal(h.plan.registrationHash, getPersonalReadonlyRegistrationHash(h.payload.registration));
  assert.equal(h.plan.repositoryIdentityHash, h.repository.identityHash); assert.equal(h.plan.requestHash, h.payload.request.hash);
  assert.equal(h.plan.limits.responseBytes, 4194304); assert.equal(h.plan.limits.outputBytes, 16384);
  assert.equal(h.plan.connectionProfileHash, '6d29d24deba28e2a1fd6058c6fb389a148da7f6150ff8edd9dbfd1bc1f52eca7');
  assert.equal(h.plan.configHash, '3d949087e8ba392a3d6fc855b15a5d9730a7d16f72b9c22f03db823333ca033c');
  assert.equal(getReadonlyRelayProfileHash(h.plan.profileId, config), h.plan.connectionProfileHash);
  assert.equal(getReadonlyRelayConfigHash(h.plan.profileId, config), h.plan.configHash);
  for (const value of [h.payload.inputText, h.payload.requestBody, JSON.stringify(h.plan)]) {
    assert.equal(value.includes(registration.sourceRoot), false); assert.equal(value.includes('"manifest"'), false);
    assert.equal(value.includes('"parents"'), false); assert.equal(value.includes('"gitEntries"'), false);
  }
  const input = JSON.parse(h.payload.inputText); assert.equal(input.evidence.length, 1);
  assert.equal(input.evidence[0].path, 'src/main.ts'); assert.equal(input.repository.repoId, registration.repoId);
  assert.equal(input.inputPolicyVersion, 'personal-readonly-input-v1'); assert.doesNotMatch(input.instructions, /synthetic/iu);
  assert.match(input.instructions, /Selected excerpts do not represent the entire repository/u);
  assert.match(input.instructions, /Do not infer missing call connections/u);
  const request = JSON.parse(h.payload.requestBody); assert.deepEqual(request.tools, []); assert.equal(request.store, false); assert.equal(request.stream, true);
});

test('private identities, question, selected evidence and plan policy cannot be swapped behind a valid transport profile', () => {
  const h = fixture();
  for (const change of [
    (value: typeof h.payload) => { value.registration.question = 'A different question'; },
    (value: typeof h.payload) => { value.registration.sourceRoot = '/private/other'; },
    (value: typeof h.payload) => { value.repository.identityHash = 'b'.repeat(64); },
    (value: typeof h.payload) => { value.repository.parents.push({ path: '/private/other', device: 1, inode: 1, mode: 0o40700, uid: process.getuid!() }); },
    (value: typeof h.payload) => { value.context.evidence[0]!.excerpt = 'invented evidence'; },
    (value: typeof h.payload) => { value.transferEvidenceIds.pop(); },
  ]) {
    const payload = structuredClone(h.payload); change(payload); assert.throws(() => validatePersonalReadonlyPayload(h.plan, payload, config));
  }
  const changed = structuredClone(h.plan); changed.limits.responseBytes = 8 * 1024 * 1024; changed.planHash = hashPersonalReadonlyPlan(changed);
  assert.throws(() => assertPersonalReadonlyPlan(changed, config));
  assert.throws(() => assertPersonalReadonlyPlan(h.plan, { ...config, policyVersion: 'readonly-relay-codex-v1' }));
  assert.throws(() => createPersonalReadonlyPayload(h.repository, { ...registration, question: 'Inspect ' + registration.sourceRoot }, h.evidence, h.now, config));
  assert.throws(() => createPersonalReadonlyPlan(h.payload, { ...h.now, now: new Date(h.payload.expiresAt) }, config), { code: 'PERSONAL_READONLY_EXPIRED' });
});

test('personal dispatch validates the new input and exact body independently of hashes and rejects old synthetic bodies', () => {
  const h = fixture();
  for (const modify of [
    (body: Record<string, unknown>) => { body.tools = [{ type: 'shell' }]; },
    (body: Record<string, unknown>) => { body.instructions = 'Investigate only the selected synthetic evidence.'; },
    (body: Record<string, unknown>) => { body.extra = true; },
    (body: Record<string, unknown>) => {
      const input = JSON.parse((body.input as { content: { text: string }[] }[])[0]!.content[0]!.text); input.repository.sourceRoot = registration.sourceRoot;
      (body.input as { content: { text: string }[] }[])[0]!.content[0]!.text = canonicalReadonlyJson(input);
    },
  ]) {
    const body = JSON.parse(h.payload.requestBody); modify(body); assert.throws(() => assertPersonalReadonlyDispatch(dispatch(canonicalReadonlyJson(body)), config));
  }
  const request = dispatch(h.payload.requestBody); request.requestBodyHash = '0'.repeat(64);
  assert.throws(() => assertPersonalReadonlyDispatch(request, config));
});

test('personal result accepts only supplied citations and rejects secrets, executable fields, forged lines and unsupported facts', () => {
  const h = fixture({ ...registration, transferPaths: ['src/main.ts'] }); const evidence = h.payload.context.evidence[0]!;
  const output = { classification: 'question', summary: 'The entry point calls submit.',
    facts: [{ text: 'main invokes submit.', references: [{ evidenceId: evidence.evidenceId, startLine: 1, endLine: 2 }] }],
    hypotheses: [], answerDraft: 'Only the supplied entry point is established.', questions: [], suggestions: [], limitations: ['Runtime behavior was not executed.'] };
  const raw = JSON.stringify(output); const parsed = parsePersonalReadonlyResult(raw, h.payload);
  assert.equal(parsed.mode, 'live'); assert.equal(parsed.responseHash, hashReadonlyValue(raw));
  for (const value of [{ ...output, command: 'npm test' }, { ...output, summary: 'Bearer SYNTHETIC_PRIVATE_CANARY_1234' },
    { ...output, summary: registration.sourceRoot },
    { ...output, facts: [] }, { ...output, facts: [{ ...output.facts[0], references: [{ evidenceId: evidence.evidenceId, startLine: 1, endLine: 3 }] }] },
    { ...output, facts: [{ ...output.facts[0], references: [{ evidenceId: h.payload.context.evidence[1]!.evidenceId, startLine: 1, endLine: 1 }] }] },
    { ...output, suggestions: [{ path: 'src/submit.ts', description: 'Change this.', references: output.facts[0]!.references }] }]) {
    assert.throws(() => parsePersonalReadonlyResult(JSON.stringify(value), h.payload));
  }
  assert.throws(() => parsePersonalReadonlyResult(raw.slice(0, -1) + ',"summary":"duplicate"}', h.payload));
  assert.equal(parsePersonalReadonlyResult(JSON.stringify({ ...output, classification: 'insufficient-evidence', facts: [] }), h.payload).classification, 'insufficient-evidence');
  assert.throws(() => parsePersonalReadonlyResult('x'.repeat(16385), h.payload), { code: 'PERSONAL_READONLY_OUTPUT_LIMIT' });
});

test('personal policy leaves the old 8897-byte synthetic relay-v2 body and frozen profile/envelope contract unchanged', async () => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'personal-policy-legacy-'))); chmodSync(directory, 0o700);
  const unlock = (path: string): void => { chmodSync(path, 0o700); for (const item of readdirSync(path, { withFileTypes: true })) if (item.isDirectory()) unlock(join(path, item.name)); };
  try {
    const source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, randomUUID()), defaultReadonlySelection(), context());
    const legacy = createReadonlyRelayPayload(source, 'codex-chatgpt-relay-v2', config);
    assert.equal(Buffer.byteLength(legacy.requestBody), 8897);
    assert.equal(legacy.requestBodyHash, 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe');
    assert.equal(legacy.connectionProfileHash, '6d29d24deba28e2a1fd6058c6fb389a148da7f6150ff8edd9dbfd1bc1f52eca7');
    assert.equal(legacy.requestEnvelopeHash, hashReadonlyRelayEnvelope(buildReadonlyRelayRequestEnvelope(legacy.requestBody, legacy.profileId, config)));
    assert.throws(() => assertPersonalReadonlyDispatch(dispatch(legacy.requestBody), config));
  } finally { unlock(directory); await rm(directory, { recursive: true, force: true }); }
});

test('registration example is an explicit placeholder and contains no live credentials', () => {
  const parsed = parsePersonalReadonlyRegistration(JSON.parse(readFileSync(join(process.cwd(), 'config/personal-readonly.example.json'), 'utf8')));
  assert.equal(parsed.repoId, 'personal-example'); assert.equal(parsed.baseCommit, '0'.repeat(40)); assert.equal(parsed.transferPaths.length, 1);
});
