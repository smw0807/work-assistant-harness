import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CompanyGitRangeBudget, getCompanyGitRangeProfile } from '../src/policy/company-git-range-budget.js';
import { assertCompanyGitWorkingIndex, findCompanyGitTreeEntry, parseCompanyGitCommitTree,
  type CompanyGitWorkingSelection } from '../src/policy/company-git-range-payload.js';

const limits = getCompanyGitRangeProfile().limits;
const treeOid = '1'.repeat(40), fileOid = '2'.repeat(40), otherOid = '3'.repeat(40);
const author = 'Synthetic Author <author@example.invalid> 1704067200 +0900';
const committer = 'Synthetic Committer <committer@example.invalid> 1704067201 -0030';
const commit = (extra = '', message = 'Synthetic message; source text is not authority.\n'): Buffer =>
  Buffer.from(`tree ${treeOid}\nparent ${otherOid}\nauthor ${author}\ncommitter ${committer}\n${extra}\n${message}`);
const state = (): CompanyGitRangeBudget => { const result = new CompanyGitRangeBudget(0); result.beginPass('inspect', 0); return result; };
const failed = (action: (budget: CompanyGitRangeBudget) => unknown, code = 'COMPANY_GIT_RANGE_INVALID_PAYLOAD'): CompanyGitRangeBudget => {
  const budget = state(); assert.throws(() => action(budget), { code });
  assert.equal(budget.snapshot().phase, 'failed'); assert.equal(budget.snapshot().liveMemoryBytes, 0);
  assert.equal(budget.snapshot().readCalls, 0); assert.equal(budget.snapshot().metadataCalls, 0); return budget;
};
interface TreeSpec { name: string | Buffer; mode?: string; oid?: string }
const tree = (entries: TreeSpec[]): Buffer => Buffer.concat(entries.map(entry => Buffer.concat([
  Buffer.from(`${entry.mode ?? '100644'} `), typeof entry.name === 'string' ? Buffer.from(entry.name) : entry.name,
  Buffer.from([0]), Buffer.from(entry.oid ?? fileOid, 'hex'),
])));

interface IndexSpec {
  path: string | Buffer; oid?: string; mode?: string; stage?: number; assumeValid?: boolean;
  extended?: number; nameLength?: number;
}
const entryBytes = (entry: IndexSpec): Buffer => {
  const name = typeof entry.path === 'string' ? Buffer.from(entry.path) : entry.path;
  const fixed = entry.extended === undefined ? 62 : 64;
  const bytes = Buffer.alloc(Math.ceil((fixed + name.length + 1) / 8) * 8);
  bytes.writeUInt32BE(Number.parseInt(entry.mode ?? '100644', 8), 24);
  Buffer.from(entry.oid ?? fileOid, 'hex').copy(bytes, 40);
  bytes.writeUInt16BE((entry.assumeValid ? 0x8000 : 0) | (entry.extended === undefined ? 0 : 0x4000)
    | (entry.stage ?? 0) << 12 | (entry.nameLength ?? Math.min(name.length, 0xfff)), 60);
  if (entry.extended !== undefined) bytes.writeUInt16BE(entry.extended, 62);
  name.copy(bytes, fixed); return bytes;
};
const checksum = (body: Buffer): Buffer => Buffer.concat([body, createHash('sha1').update(body).digest()]);
const extension = (name: string, content: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(8); header.write(name, 0, 'ascii'); header.writeUInt32BE(content.length, 4);
  return Buffer.concat([header, content]);
};
const index = (entries: IndexSpec[], version = 2, extensions: Buffer[] = []): Buffer => {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(version, 4); header.writeUInt32BE(entries.length, 8);
  return checksum(Buffer.concat([header, ...entries.map(entryBytes), ...extensions]));
};
const selected: readonly CompanyGitWorkingSelection[] = [{ path: 'a.ts', oid: fileOid, mode: '100644' }];
const mutateIndex = (value: Buffer, change: (bytes: Buffer) => void): Buffer => {
  const body = Buffer.from(value.subarray(0, -20)); change(body); return checksum(body);
};
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

test('commit parser returns only the root OID while accepting parents and opaque multiline signatures', () => {
  for (const value of [commit(), commit('encoding UTF-8\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n SYNTHETIC_SIGNATURE_DATA\n -----END PGP SIGNATURE-----\n'),
    commit('mergetag object synthetic\n type commit\n tag synthetic\n'),
    Buffer.from(`tree ${treeOid}\nauthor ${author}\ncommitter ${committer}\n\n`),
    Buffer.from(`tree ${treeOid}\nparent ${fileOid}\nparent ${otherOid}\nauthor ${author}\ncommitter ${committer}\n\n한국어 메시지\n`)]) {
    const budget = state(), before = createHash('sha256').update(value).digest('hex');
    const result = parseCompanyGitCommitTree(value, budget, 0);
    assert.equal(result, treeOid); assert.equal(result.length, 40);
    assert.equal(createHash('sha256').update(value).digest('hex'), before);
    value.fill(0); assert.equal(result, treeOid); assert.equal(budget.snapshot().liveMemoryBytes, 0);
    assert.equal(budget.snapshot().readCalls, 0); assert.equal(budget.snapshot().openDescriptors, 0);
  }
});

test('commit parser rejects missing, duplicate, misplaced or malformed mandatory metadata without exposing it', () => {
  const source = commit().toString('utf8');
  const bad = [source.replace(`tree ${treeOid}`, `tree ${treeOid}\ntree ${fileOid}`),
    source.replace(`author ${author}\n`, ''), source.replace(`committer ${committer}\n`, ''),
    source.replace(`author ${author}`, `author ${author}\nauthor ${author}`),
    source.replace(`committer ${committer}`, `committer ${committer}\ncommitter ${committer}`),
    source.replace(`tree ${treeOid}\n`, ''), source.replace(`tree ${treeOid}`, `author ${author}\ntree ${treeOid}`),
    source.replace(`tree ${treeOid}`, `tree ${treeOid.toUpperCase().replace('1', 'A')}`),
    source.replace(`parent ${otherOid}`, 'parent invalid-oid'),
    source.replace(`committer ${committer}`, `committer ${committer}\nparent ${fileOid}`),
    source.replace(`author ${author}`, 'author invalid'), source.replace('+0900', '+2460'),
    source.replace('1704067200', '9007199254740992'), source.replace('1704067200', '01'),
    source.replace(`author ${author}`, `author ${author}\n continuation`),
    source.replace('\n\n', '\n'), ' ' + source, '\ufeff' + source, source.replace('\n', '\r\n'), source + '\0'];
  for (const value of bad) {
    failed(budget => parseCompanyGitCommitTree(Buffer.from(value), budget, 0));
  }
  failed(budget => parseCompanyGitCommitTree(Buffer.concat([commit(), Buffer.from([0xff])]), budget, 0));
});

test('commit object byte bound applies without retaining input or changing the existing profile', () => {
  const prefix = commit('', '').toString('utf8'), atLimit = Buffer.from(prefix + 'x'.repeat(limits.objectBytes - Buffer.byteLength(prefix)));
  const budget = state(); assert.equal(parseCompanyGitCommitTree(atLimit, budget, 0), treeOid);
  assert.equal(budget.snapshot().peakMemoryBytes, limits.objectBytes); assert.equal(budget.snapshot().liveMemoryBytes, 0);
  failed(budget => parseCompanyGitCommitTree(Buffer.concat([atLimit, Buffer.from('x')]), budget, 0));
});

test('tree parser applies Git byte ordering, returns canonical modes and checks every entry', () => {
  const value = tree([{ name: 'a.c' }, { name: 'a', mode: '40000', oid: treeOid }, { name: 'link', mode: '120000' },
    { name: 'module', mode: '160000' }, { name: 'z', mode: '100755' }]);
  for (const [name, mode] of [['a.c', '100644'], ['a', '40000'], ['link', '120000'], ['module', '160000'], ['z', '100755']] as const) {
    const budget = state(), result = findCompanyGitTreeEntry(value, name, budget, 0);
    assert.deepEqual(result, { mode, oid: name === 'a' ? treeOid : fileOid }); assert.ok(Object.isFrozen(result));
    assert.equal(budget.snapshot().liveMemoryBytes, 0);
  }
  assert.equal(findCompanyGitTreeEntry(value, 'missing', state(), 0), undefined);
  assert.equal(findCompanyGitTreeEntry(Buffer.alloc(0), 'missing', state(), 0), undefined);
  const unicode = tree([{ name: '\ue000' }, { name: '\u{10000}' }]);
  assert.deepEqual(findCompanyGitTreeEntry(unicode, '\u{10000}', state(), 0), { oid: fileOid, mode: '100644' });
  const invalidTail = Buffer.concat([tree([{ name: 'a' }]), Buffer.from('100644 missing-terminator')]);
  failed(budget => findCompanyGitTreeEntry(invalidTail, 'a', budget, 0));
});

test('tree parser rejects unsafe names, unsupported modes, duplicates, invalid UTF-8 and incomplete OIDs', () => {
  for (const name of ['', '.', '..', '../escape', 'dir/file', 'dir\\file', 'name:stream', '.git', '.GIT ', '.g\u200cit', '\ufeff.git', 'git~1', 'x\nname']) {
    failed(budget => findCompanyGitTreeEntry(tree([{ name }]), 'safe', budget, 0));
  }
  for (const mode of ['040000', '100600', '000000', '100644extra', '240000']) {
    failed(budget => findCompanyGitTreeEntry(tree([{ name: 'safe', mode }]), 'safe', budget, 0));
  }
  const bad = [tree([{ name: 'b' }, { name: 'a' }]), tree([{ name: 'a', mode: '40000' }, { name: 'a.c' }]),
    tree([{ name: 'a' }, { name: 'a' }]), tree([{ name: 'a' }, { name: 'a.c' }, { name: 'a', mode: '40000' }]),
    tree([{ name: Buffer.from([0xc0, 0xaf]) }]), tree([{ name: 'a' }]).subarray(0, -1),
    tree([{ name: '\u{10000}' }, { name: '\ue000' }])];
  for (const value of bad) failed(budget => findCompanyGitTreeEntry(value, 'safe', budget, 0));
  for (const name of ['.', '..', '.git', 'a/b', 'a\\b', '\ud800']) {
    failed(budget => findCompanyGitTreeEntry(Buffer.alloc(0), name, budget, 0));
  }
  failed(budget => findCompanyGitTreeEntry(Buffer.alloc(limits.objectBytes + 1), 'safe', budget, 0));
});

test('working index v2/v3 validates selected entries while allowing unrelated conflict stages and known extended bits', () => {
  const values = [index([{ path: 'a.ts', assumeValid: true }, { path: 'b.ts', mode: '120000' }]),
    index([{ path: 'a.ts' }, { path: 'b.ts', extended: 0x4000 }, { path: 'c.ts', extended: 0x2000 }], 3),
    index([{ path: 'a.ts' }, { path: 'b.ts', stage: 1 }, { path: 'b.ts', stage: 2 }, { path: 'b.ts', stage: 3 }], 3),
    index([{ path: 'a.ts' }], 2, [extension('TREE', Buffer.from('opaque optional bytes')), extension('ABcd')])];
  for (const value of values) {
    const budget = state(), before = sha256(value);
    assertCompanyGitWorkingIndex(value, selected, budget, 0);
    assert.equal(sha256(value), before); assert.equal(budget.snapshot().liveMemoryBytes, 0);
    assert.equal(budget.snapshot().readCalls, 0); assert.equal(budget.snapshot().metadataCalls, 0);
  }
  const executable = [{ path: 'a.ts', oid: fileOid, mode: '100755' }] as const;
  assertCompanyGitWorkingIndex(index([{ path: 'a.ts', mode: '100755' }]), executable, state(), 0);
});

test('working index rejects selected missing, mismatched, staged and extended entries even with valid checksums', () => {
  const bad = [index([{ path: 'b.ts' }]), index([{ path: 'a.ts', oid: otherOid }]), index([{ path: 'a.ts', mode: '100755' }]),
    index([{ path: 'a.ts', stage: 1 }]), index([{ path: 'a.ts', extended: 0 }], 3), index([{ path: 'a.ts', extended: 0x4000 }], 3),
    index([{ path: 'a.ts', extended: 0x2000 }], 3), index([{ path: 'a.ts' }, { path: 'a.ts' }]),
    index([{ path: 'a.ts' }, { path: 'a.ts', stage: 1 }]), index([{ path: 'b.ts' }, { path: 'a.ts' }]),
    index([{ path: 'a.ts' }, { path: 'b.ts', stage: 2 }, { path: 'b.ts', stage: 1 }])];
  for (const value of bad) failed(budget => assertCompanyGitWorkingIndex(value, selected, budget, 0));
});

test('working index checks checksum, all padding, byte path length, flags, modes and extension envelopes', () => {
  const valid = index([{ path: 'a.ts' }]), wrongChecksum = Buffer.from(valid);
  wrongChecksum[wrongChecksum.length - 1] = wrongChecksum[wrongChecksum.length - 1]! ^ 1;
  const bad = [wrongChecksum, index([{ path: 'a.ts' }], 4), index([{ path: 'a.ts', mode: '100600' }]),
    index([{ path: 'a.ts', extended: 0x4000 }], 2), index([{ path: 'a.ts' }, { path: 'b.ts', extended: 1 }], 3),
    index([{ path: 'a.ts', nameLength: 3 }]), index([{ path: 'a.ts', nameLength: 0xfff }]),
    mutateIndex(valid, bytes => { bytes[0] = 0xc4; }), mutateIndex(valid, bytes => { bytes[12 + 67] = 1; }),
    mutateIndex(valid, bytes => { bytes.writeUInt32BE(1000000000, 12 + 4); }),
    index([{ path: 'a.ts' }], 2, [extension('link')]), index([{ path: 'a.ts' }], 2, [extension('sdir')]),
    index([{ path: 'a.ts' }], 2, [extension('TREE'), extension('TREE')]),
    index([{ path: 'a.ts' }], 2, [Buffer.from('TREE')]),
    index([{ path: 'a.ts' }], 2, [Buffer.from([84, 82, 69, 69, 0xff, 0xff, 0xff, 0xff])])];
  for (const value of bad) failed(budget => assertCompanyGitWorkingIndex(value, selected, budget, 0));
  const korean: readonly CompanyGitWorkingSelection[] = [{ path: '한.ts', oid: fileOid, mode: '100644' }];
  assertCompanyGitWorkingIndex(index([{ path: '한.ts' }]), korean, state(), 0);
  failed(budget => assertCompanyGitWorkingIndex(index([{ path: '한.ts', nameLength: '한.ts'.length }]), korean, budget, 0));
  const longPath = 'a'.repeat(4095);
  assertCompanyGitWorkingIndex(index([{ path: longPath }, { path: 'b.ts' }]), [{ path: 'b.ts', oid: fileOid, mode: '100644' }], state(), 0);
});

test('working index rejects unsafe or malformed unselected paths rather than returning early after a selected match', () => {
  for (const path of ['z/../escape', 'z//file', 'z/.git/file', 'z/.GIT /file', 'z/.g\u200cit/file', 'z/git~1/file',
    'z\\file', 'z:stream', 'z/file\n', '/absolute', 'z/']) {
    failed(budget => assertCompanyGitWorkingIndex(index([{ path: 'a.ts' }, { path }]), selected, budget, 0));
  }
  failed(budget => assertCompanyGitWorkingIndex(index([{ path: 'a.ts' }, { path: Buffer.from([122, 0xff]) }]), selected, budget, 0));
});

test('working index accepts exactly 65536 structural entries and rejects larger declarations and byte buffers', () => {
  const count = limits.workingIndexObjects, entryLength = 72, body = Buffer.alloc(12 + count * entryLength);
  body.write('DIRC'); body.writeUInt32BE(2, 4); body.writeUInt32BE(count, 8);
  const template = entryBytes({ path: 'f00000.ts' }); assert.equal(template.length, entryLength);
  for (let position = 0; position < count; position++) {
    const offset = 12 + position * entryLength; template.copy(body, offset); body.write(`f${String(position).padStart(5, '0')}.ts`, offset + 62, 'ascii');
  }
  const budget = state(); assertCompanyGitWorkingIndex(checksum(body), [{ path: 'f00000.ts', oid: fileOid, mode: '100644' }], budget, 0);
  assert.equal(budget.snapshot().liveMemoryBytes, 0);
  failed(budget => assertCompanyGitWorkingIndex(mutateIndex(index([{ path: 'a.ts' }]), bytes => bytes.writeUInt32BE(count + 1, 8)), selected, budget, 0));
  failed(budget => assertCompanyGitWorkingIndex(Buffer.alloc(limits.gitFileBytes + 1), selected, budget, 0));
});

test('byte ownership and selection boundaries reject getters, proxies, shared storage and forged fields without evaluation', () => {
  const valid = index([{ path: 'a.ts' }]); let reads = 0;
  const shadow = Object.defineProperty(Buffer.from(valid), 'buffer', { get() { reads++; throw new Error('SYNTHETIC_GETTER'); } });
  const shared = new Uint8Array(new SharedArrayBuffer(valid.length)); shared.set(valid);
  const inherited = Object.setPrototypeOf(Buffer.from(valid), Object.create(Buffer.prototype));
  for (const input of [shadow, shared, inherited, new DataView(new ArrayBuffer(4)), new Proxy(Buffer.from(valid), {})]) {
    failed(budget => assertCompanyGitWorkingIndex(input as Uint8Array, selected, budget, 0));
  }
  const getter = Object.defineProperty({ ...selected[0] }, 'path', { enumerable: true, get() { reads++; return 'a.ts'; } });
  for (const selection of [[getter], [{ ...selected[0], extra: true }], [selected[0], selected[0]], new Array(1),
    Object.assign(Object.create({ inherited: true }), selected), [{ path: '../escape', oid: fileOid, mode: '100644' }]]) {
    failed(budget => assertCompanyGitWorkingIndex(valid, selection as readonly CompanyGitWorkingSelection[], budget, 0));
  }
  assert.equal(reads, 0);
});

test('payload parsing preserves timeout and memory-limit errors while releasing only its own leases', () => {
  const timed = failed(budget => parseCompanyGitCommitTree(commit(), budget, limits.wallClockMs), 'COMPANY_GIT_RANGE_TIMEOUT');
  assert.equal(timed.snapshot().failureCode, 'COMPANY_GIT_RANGE_TIMEOUT');
  const budget = state(), external = budget.reserveMemory(limits.managedBytes);
  assert.throws(() => findCompanyGitTreeEntry(tree([{ name: 'a' }]), 'a', budget, 0), { code: 'COMPANY_GIT_RANGE_LIMIT' });
  assert.equal(budget.snapshot().liveMemoryBytes, limits.managedBytes); budget.releaseMemory(external);
  assert.equal(budget.snapshot().liveMemoryBytes, 0); assert.equal(budget.snapshot().failureCode, 'COMPANY_GIT_RANGE_LIMIT');
});
