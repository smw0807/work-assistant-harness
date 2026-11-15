import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import git from 'isomorphic-git';
import { assertPersonalCollectionPayloadNow, collectPersonalCollectionEvidence, inspectPersonalCollectionRepository } from '../src/adapters/personal-readonly-collection-repository.js';
import { inspectPersonalReadonlyRepository } from '../src/adapters/personal-readonly-repository.js';
import type { PersonalCollectionRegistration } from '../src/domain/personal-readonly-collection.js';
import type { PersonalReadonlyRegistration } from '../src/domain/personal-readonly.js';
import type { ReadonlyRelayConfig } from '../src/domain/readonly-relay.js';
import { derivePersonalSourceView, extractPersonalCollectionEvidence, getPersonalCollectionProfile,
  getPersonalCollectionProfileHash } from '../src/policy/personal-readonly-collection.js';
import { createPersonalCollectionPayload } from '../src/policy/personal-readonly-collection-policy.js';
import { canonicalReadonlyJson, hashReadonlyValue, READONLY_LIMITS } from '../src/policy/readonly-investigation-policy.js';
import { inspectEvidenceText } from '../src/policy/read-policy.js';

const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v2', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const context = () => ({ ownerId: `os-user:${process.getuid!()}`, now: new Date() });
const author = { name: 'Synthetic Collection', email: 'collection@example.invalid', timestamp: 1704067200, timezoneOffset: 0 };
const range = { path: 'src/example.ts', startLine: 1, endLine: 1 };
const derive = (text: string | Buffer) => derivePersonalSourceView(range.path, Buffer.from(text));
const oldScan = (bytes: Uint8Array) => inspectEvidenceText({ repoId: 'test', root: '/', baseCommit: 'a'.repeat(40),
  allowedPaths: [range.path], maxFileBytes: 32768, maxEvidenceBytes: 65536 }, { repoId: 'test', ...range }, bytes);
const setup = async (testContext: TestContext, files: Record<string, string>) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'personal-collection-test-')));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) { fs.mkdirSync(dirname(join(root, path)), { recursive: true }); fs.writeFileSync(join(root, path), text); }
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  for (const filepath of Object.keys(files)) await git.add({ fs, dir: root, filepath });
  const baseCommit = await git.commit({ fs, dir: root, author, committer: author, message: 'Synthetic safe-view fixture' });
  const registration: PersonalCollectionRegistration = { version: 'personal-readonly-registration-v2', collectionPolicy: 'personal-readonly-collection-v2',
    repoId: 'collection-test', sourceRoot: root, baseCommit, question: 'Explain only the selected safe evidence and uncertainty.',
    readRanges: Object.keys(files).sort().map((path) => ({ path, startLine: 1, endLine: 1 })), transferPaths: Object.keys(files).sort() };
  return { root, registration };
};
const snapshot = (root: string): string => {
  const entries: unknown[] = [];
  const visit = (path: string): void => {
    const stat = fs.lstatSync(path);
    entries.push({ path: path.slice(root.length), mode: stat.mode, inode: stat.ino, size: stat.size,
      modified: stat.mtimeMs, changed: stat.ctimeMs, hash: stat.isFile() ? hashReadonlyValue(fs.readFileSync(path)) : '' });
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); return canonicalReadonlyJson(entries);
};
const v1 = (registration: PersonalCollectionRegistration): PersonalReadonlyRegistration => {
  return { version: 'personal-readonly-registration-v1', repoId: registration.repoId, sourceRoot: registration.sourceRoot,
    baseCommit: registration.baseCommit, question: registration.question, readRanges: registration.readRanges, transferPaths: registration.transferPaths };
};

test('collection profile separates fixed source/view/excerpt budgets while old 32KiB contract stays unchanged', () => {
  const profile = getPersonalCollectionProfile();
  assert.equal(profile.policy, 'personal-readonly-collection-v2');
  assert.deepEqual(profile.limits, { sourceFileBytes: 65536, fullViewBytes: 65536, excerptBytes: 32768,
    evidenceBytes: 65536, inputBytes: 131072, files: 8, ranges: 16, linesPerRange: 200, masks: 128 });
  assert.equal(READONLY_LIMITS.fileBytes, 32768);
  assert.equal(getPersonalCollectionProfileHash(), hashReadonlyValue(canonicalReadonlyJson(profile)));
  assert.throws(() => { profile.limits.sourceFileBytes = 65536 + 1 as 65536; });
});

test('collection no-mask bytes preserve Unicode, BOM and CRLF exactly with raw/view identity', () => {
  for (const text of ['export const value = 42;\n', '\ufeff첫 줄\r\n둘째 줄\r\n', '한글🙂 without terminal newline']) {
    const bytes = Buffer.from(text), view = derive(bytes);
    assert.deepEqual(Buffer.from(view.bytes), bytes); assert.equal(view.sourceHash, view.viewHash);
    assert.equal(view.sourceBytes, view.viewBytes); assert.equal(view.sourceLines, view.viewLines);
    assert.equal(view.rawSensitiveCheck, 'passed'); assert.equal(view.viewSensitiveCheck, 'passed');
    assert.equal(view.maskCount, 0); assert.deepEqual(view.maskedLines, []);
  }
});

test('collection keeps raw sensitive rejection and masks every shared/additional pattern before the same full scan', () => {
  const samples = ['const accessToken = "SYNTHETIC_PRIVATE_VALUE_A";\n', 'Bearer SYNTHETIC_PRIVATE_VALUE_A\n',
    'xoxb-a\n', `ASIA${'A'.repeat(16)}\n`, `ghp_${'A'.repeat(22)}\n`, `sk-proj-${'A'.repeat(18)}\n`];
  for (const text of samples) {
    assert.throws(() => oldScan(Buffer.from(text)), { code: 'SECRET_CONTENT_BLOCKED' });
    const view = derive(text); assert.equal(view.rawSensitiveCheck, 'rejected'); assert.equal(view.viewSensitiveCheck, 'passed');
    assert.ok(view.maskCount > 0); assert.equal(view.sourceLines, view.viewLines);
    assert.doesNotThrow(() => oldScan(view.bytes));
    assert.equal(Buffer.from(view.bytes).includes(Buffer.from('SYNTHETIC_PRIVATE_VALUE_A')), false);
  }
});

test('collection overlap merges a credential assignment and its nested bearer pattern into one mask', () => {
  const view = derive('const accessToken = "Bearer SYNTHETIC_OVERLAP_VALUE_A";\n');
  assert.equal(view.maskCount, 1); assert.deepEqual(view.maskedLines, [{ startLine: 1, endLine: 1 }]);
  assert.equal(Buffer.from(view.bytes).toString().includes('Bearer'), false);
});

test('collection complete private key covers its entire body and preserves following safe lines', () => {
  const view = derive('before\r\n-----BEGIN RSA PRIVATE KEY-----\r\nSYNTHETIC_BASE64_BODY\r\n-----END RSA PRIVATE KEY-----\r\nafter\r\n');
  const text = Buffer.from(view.bytes).toString();
  assert.equal(text.includes('SYNTHETIC_BASE64_BODY'), false); assert.equal(text.includes('PRIVATE KEY'), false);
  assert.ok(text.endsWith('\r\nafter\r\n')); assert.equal(view.sourceLines, 5); assert.equal(view.viewLines, 5);
  assert.equal(view.maskCount, 1); assert.deepEqual(view.maskedLines, [{ startLine: 2, endLine: 4 }]);
});

test('collection incomplete or mismatched private key covers all remaining lines through EOF', () => {
  for (const end of ['', '\n-----END EC PRIVATE KEY-----\ntrailing-private-material']) {
    const view = derive(`safe\n-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_TRUNCATED_BODY${end}`);
    const text = Buffer.from(view.bytes).toString();
    assert.equal(text.includes('SYNTHETIC_TRUNCATED_BODY'), false); assert.equal(text.includes('trailing-private-material'), false);
    assert.equal(text.includes('PRIVATE KEY'), false); assert.equal(view.sourceLines, view.viewLines);
    assert.equal(view.maskedLines[0]?.startLine, 2); assert.equal(view.maskedLines[0]?.endLine, view.sourceLines);
  }
});

test('collection mask count is bounded after merging; 129 independent masks fail closed', () => {
  const view = derive('token=null;\n'.repeat(128)); assert.equal(view.maskCount, 128); assert.equal(view.maskedLines.length, 128);
  assert.throws(() => derive('token=null;\n'.repeat(129)), { code: 'PERSONAL_COLLECTION_INVALID_VIEW' });
  assert.throws(() => derive('-----BEGIN PRIVATE KEY-----\n' + 'token=null;\n'.repeat(1025)
    + '-----END PRIVATE KEY-----\n'), { code: 'PERSONAL_COLLECTION_INVALID_VIEW' });
});

test('collection 64KiB source/view and 32KiB excerpt limits reject overflow without truncation', () => {
  const exact = derive('a'.repeat(65536)); assert.equal(exact.viewBytes, 65536);
  assert.throws(() => derive('a'.repeat(65537)));
  assert.throws(() => derive('token=a;' + 'z'.repeat(65536 - 8)));
  const excerpt = derive('a'.repeat(32768) + '\n');
  assert.equal(extractPersonalCollectionEvidence('test', 'a'.repeat(40), range, excerpt).excerpt.length, 32768);
  assert.throws(() => extractPersonalCollectionEvidence('test', 'a'.repeat(40), range, derive('a'.repeat(32769) + '\n')));
  assert.throws(() => extractPersonalCollectionEvidence('test', 'a'.repeat(40), { ...range, endLine: 201 }, derive('line\n'.repeat(201))));
});

test('collection invalid UTF8, control bytes and forbidden paths fail before a view can be used', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('token=x\0\n')]) assert.throws(() => derivePersonalSourceView(range.path, bytes));
  for (const path of ['.env', '.git/config', '../escape.ts', '/etc/passwd']) assert.throws(() => derivePersonalSourceView(path, Buffer.from('safe\n')));
});

test('collection safe evidence binds full-view SHA and rechecks bytes against mutation', () => {
  const view = derive('const token = "SYNTHETIC_PRIVATE_VALUE_A";\nexport const value = 42;\n');
  const evidence = extractPersonalCollectionEvidence('test', 'a'.repeat(40), { ...range, startLine: 2, endLine: 2 }, view);
  assert.equal(evidence.fileHash, view.viewHash); assert.notEqual(evidence.fileHash, view.sourceHash);
  assert.equal(evidence.excerpt, 'export const value = 42;');
  view.bytes[0] = view.bytes[0]! ^ 1;
  assert.throws(() => extractPersonalCollectionEvidence('test', 'a'.repeat(40), range, view));
});

test('collection supports a committed 40KiB file and masked source while old reader rejects both independently', async (testContext) => {
  const large = 'export const value = 42;\n' + '// safe padding\n'.repeat(2700);
  const secret = 'const token = "SYNTHETIC_PRIVATE_VALUE_A";\nexport const run = () => 42;\n';
  const { root, registration } = await setup(testContext, { 'src/large.ts': large, 'src/client.ts': secret });
  assert.ok(Buffer.byteLength(large) > 32768 && Buffer.byteLength(large) < 65536);
  const before = snapshot(root);
  for (const path of registration.transferPaths) await assert.rejects(inspectPersonalReadonlyRepository({ ...v1(registration),
    readRanges: [{ path, startLine: 1, endLine: 1 }], transferPaths: [path] }, randomUUID()));
  const repository = await inspectPersonalCollectionRepository(registration, randomUUID());
  const collected = await collectPersonalCollectionEvidence(repository, registration);
  assert.equal(collected.evidence.length, 2); assert.equal(collected.sourceViews.length, 2);
  const proof = collected.sourceViews.find((item) => item.path === 'src/client.ts')!;
  assert.equal(proof.rawSensitiveCheck, 'rejected'); assert.equal(Object.hasOwn(proof, 'bytes'), false);
  assert.equal(repository.manifest.find((item) => item.path === 'src/client.ts')?.hash, hashReadonlyValue(secret));
  assert.equal(collected.evidence.find((item) => item.path === 'src/client.ts')?.fileHash, proof.viewHash);
  assert.equal(JSON.stringify(collected).includes('SYNTHETIC_PRIVATE_VALUE_A'), false);
  const payload = createPersonalCollectionPayload(repository, registration, collected, context(), config);
  assertPersonalCollectionPayloadNow(payload); assert.equal(snapshot(root), before);
});

test('collection fresh guard rejects raw changes even when derived view remains identical', async (testContext) => {
  const first = 'const token = "SYNTHETIC_PRIVATE_VALUE_A";\nexport const value = 42;\n';
  const second = first.replace('VALUE_A', 'VALUE_B'); assert.equal(derive(first).viewHash, derive(second).viewHash);
  const { root, registration } = await setup(testContext, { 'src/example.ts': first });
  const repository = await inspectPersonalCollectionRepository(registration, randomUUID());
  const payload = createPersonalCollectionPayload(repository, registration, await collectPersonalCollectionEvidence(repository, registration), context(), config);
  assertPersonalCollectionPayloadNow(payload);
  fs.writeFileSync(join(root, 'src/example.ts'), second);
  assert.throws(() => assertPersonalCollectionPayloadNow(payload), { code: 'PERSONAL_COLLECTION_SOURCE_CHANGED' });
});

test('collection fresh guard regenerates proof and excerpts rather than accepting hash-only changes', async (testContext) => {
  const { registration } = await setup(testContext, { 'src/example.ts': 'const token = "SYNTHETIC_PRIVATE_VALUE_A";\nexport const value = 42;\n' });
  const repository = await inspectPersonalCollectionRepository(registration, randomUUID());
  const payload = createPersonalCollectionPayload(repository, registration, await collectPersonalCollectionEvidence(repository, registration), context(), config);
  for (const change of ['evidence', 'proof', 'profile']) {
    const altered = structuredClone(payload);
    if (change === 'evidence') altered.context.evidence[0]!.excerpt = 'fabricated safe excerpt';
    if (change === 'proof') { altered.sourceViews[0]!.maskCount++; altered.sourceViewsHash = hashReadonlyValue(canonicalReadonlyJson(altered.sourceViews)); }
    if (change === 'profile') altered.collectionProfileHash = 'a'.repeat(64);
    assert.throws(() => assertPersonalCollectionPayloadNow(altered));
  }
  let getters = 0; const bad = Object.defineProperty({ ...payload }, 'sourceViews', { enumerable: true, get() { getters++; return []; } });
  assert.throws(() => assertPersonalCollectionPayloadNow(bad)); assert.equal(getters, 0);
});

test('collection retains total evidence64KiB and source64KiB caps in filesystem collection', async (testContext) => {
  const { registration } = await setup(testContext, { 'a.ts': 'a'.repeat(24576), 'b.ts': 'b'.repeat(24576), 'c.ts': 'c'.repeat(24576) });
  const repository = await inspectPersonalCollectionRepository(registration, randomUUID());
  await assert.rejects(collectPersonalCollectionEvidence(repository, registration));
  const large = await setup(testContext, { 'large.ts': 'z'.repeat(65537) });
  await assert.rejects(inspectPersonalCollectionRepository(large.registration, randomUUID()));
});
