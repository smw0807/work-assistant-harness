import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { CompanyGitRangeBudget, getCompanyGitRangeProfile } from '../src/policy/company-git-range-budget.js';
import { assertCompanyGitVerifiedObject, companyGitRangeCrc32, decodeCompanyGitLooseObject,
  decodeCompanyGitPackedObject, resolveCompanyGitPackedObjects, type CompanyGitPackedRecord } from '../src/policy/company-git-range-object-codec.js';

const limits = getCompanyGitRangeProfile().limits, packIdentity = 'a'.repeat(64);
const budget = (): CompanyGitRangeBudget => { const value = new CompanyGitRangeBudget(0); value.beginPass('inspect', 0); return value; };
const oid = (type: string, content: Uint8Array): string => createHash('sha1').update(`${type} ${content.byteLength}\0`).update(content).digest('hex');
const sha256 = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');
const sizeHeader = (type: number, size: number): Buffer => {
  let remaining = Math.floor(size / 16); const result = [(type << 4) | size & 15 | (remaining ? 128 : 0)];
  while (remaining) { const next = remaining & 127; remaining = Math.floor(remaining / 128); result.push(next | (remaining ? 128 : 0)); }
  return Buffer.from(result);
};
const varint = (size: number): number[] => {
  const result: number[] = [];
  do { const next = size & 127; size = Math.floor(size / 128); result.push(next | (size ? 128 : 0)); } while (size);
  return result;
};
const ofsDistance = (distance: number): Buffer => {
  const result = [distance & 127];
  while ((distance = Math.floor(distance / 128))) { distance--; result.unshift(128 | distance & 127); }
  return Buffer.from(result);
};
const record = (bytes: Buffer, expectedOid: string, offset = 12): CompanyGitPackedRecord => ({ bytes,
  entry: { oid: expectedOid, offset, length: bytes.length, crc32: companyGitRangeCrc32(bytes) } });
const packed = (type: number, content: Buffer, expectedOid = oid('blob', content), offset = 12, reference: Buffer = Buffer.alloc(0)): CompanyGitPackedRecord =>
  record(Buffer.concat([sizeHeader(type, content.length), reference, deflateSync(content)]), expectedOid, offset);
const loose = (type: string, content: Buffer): Buffer => deflateSync(Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]));
const refDelta = (base: CompanyGitPackedRecord, content: Buffer, target: Buffer, offset: number): CompanyGitPackedRecord =>
  packed(7, content, oid('blob', target), offset, Buffer.from(base.entry.oid, 'hex'));
const resolve = (records: CompanyGitPackedRecord[], state = budget()) => ({ state,
  object: resolveCompanyGitPackedObjects(records, records.at(-1)!.entry.oid, packIdentity, state, 0) });
const rejected = (action: (state: CompanyGitRangeBudget) => unknown, code = 'COMPANY_GIT_RANGE_INVALID_OBJECT'): CompanyGitRangeBudget => {
  const state = budget(); assert.throws(() => action(state), { code });
  assert.equal(state.snapshot().phase, 'failed'); assert.equal(state.snapshot().liveMemoryBytes, 0);
  assert.equal(state.snapshot().pendingInflations, 0); assert.equal(state.snapshot().dependencyDepth, 0); return state;
};

test('packed ordinary objects bind CRC, exact compressed span, type and Git OID with owned output', () => {
  assert.equal(companyGitRangeCrc32(Buffer.from('123456789')), 0xcbf43926);
  for (const [type, code] of [['commit', 1], ['tree', 2], ['blob', 3], ['tag', 4]] as const) {
    const content = Buffer.from(`Synthetic ${type} bytes\n`), input = packed(code, content, oid(type, content)), state = budget();
    const result = decodeCompanyGitPackedObject(input.bytes, input.entry, packIdentity, state, 0);
    assert.equal(result.type, type); assert.equal(result.oid, input.entry.oid); assert.equal(result.base, null);
    assert.equal(result.encodedSha256, sha256(input.bytes)); assert.deepEqual(result.bytes, content);
    assert.equal(result.bytes.buffer.byteLength, result.bytes.length);
    assert.equal(state.snapshot().liveMemoryBytes, content.length);
    (input.bytes as Buffer).fill(0); assert.deepEqual(result.bytes, content);
    assertCompanyGitVerifiedObject(result, state, 0); state.releaseMemory(result.memoryLease);
    assert.equal(state.snapshot().liveMemoryBytes, 0);
  }
  const empty = packed(3, Buffer.alloc(0)), state = budget();
  const decoded = decodeCompanyGitPackedObject(empty.bytes, empty.entry, packIdentity, state, 0);
  assert.equal(decoded.bytes.length, 0); state.releaseMemory(decoded.memoryLease);
});

test('byte, record and entry accessors or unsupported backing storage are never evaluated', () => {
  const source = packed(3, Buffer.from('Synthetic safe bytes')); let getters = 0;
  const shadow = Object.defineProperty(Buffer.from(source.bytes), 'buffer', { get() { getters++; throw new Error('must not run'); } });
  const inherited = Object.setPrototypeOf(Buffer.from(source.bytes), Object.create(Buffer.prototype));
  const shared = new Uint8Array(new SharedArrayBuffer(source.bytes.length)); shared.set(source.bytes);
  const resizable = new Uint8Array(Reflect.construct(ArrayBuffer, [source.bytes.length, { maxByteLength: source.bytes.length + 1 }]) as ArrayBuffer); resizable.set(source.bytes);
  for (const value of [shadow, inherited, shared, resizable, new DataView(new ArrayBuffer(8)), new Uint16Array(8),
    new Proxy(Buffer.from(source.bytes), {}), [1, 2, 3]]) {
    rejected(state => decodeCompanyGitPackedObject(value, source.entry, packIdentity, state, 0), 'COMPANY_GIT_RANGE_INVALID_BYTES');
  }
  const entry = Object.defineProperty({ ...source.entry }, 'oid', { enumerable: true, get() { getters++; return source.entry.oid; } });
  rejected(state => decodeCompanyGitPackedObject(source.bytes, entry, packIdentity, state, 0));
  const input = Object.defineProperty({ ...source }, 'bytes', { enumerable: true, get() { getters++; return source.bytes; } });
  rejected(state => resolveCompanyGitPackedObjects([input], source.entry.oid, packIdentity, state, 0));
  assert.equal(getters, 0);
});

test('wrong CRC is rejected before inflation and a corrected CRC cannot conceal an OID forgery', () => {
  const input = packed(3, Buffer.from('original synthetic object'));
  const crcFailure = rejected(state => decodeCompanyGitPackedObject(input.bytes, { ...input.entry, crc32: (input.entry.crc32 ^ 1) >>> 0 }, packIdentity, state, 0));
  assert.equal(crcFailure.snapshot().inflations, 0);
  const altered = packed(3, Buffer.from('altered synthetic object'), input.entry.oid);
  rejected(state => decodeCompanyGitPackedObject(altered.bytes, altered.entry, packIdentity, state, 0));
});

test('packed type, size, OFS/REF framing and exact zlib EOF reject malformed representations', () => {
  const content = Buffer.from('bounded'), expected = oid('blob', content);
  const bad = [Buffer.concat([sizeHeader(0, content.length), deflateSync(content)]),
    Buffer.concat([sizeHeader(5, content.length), deflateSync(content)]),
    Buffer.concat([sizeHeader(3, limits.objectBytes + 1), deflateSync(content)]),
    Buffer.concat([Buffer.from([0xb0, 0x80, 0x80, 0x80, 0]), deflateSync(content)]),
    Buffer.concat([Buffer.from([0xb1, 0]), deflateSync(content)]),
    Buffer.from([0xb0]), Buffer.from([0x71, 1, 2]),
    Buffer.concat([sizeHeader(6, content.length), Buffer.from([0]), deflateSync(content)]),
    Buffer.concat([sizeHeader(6, content.length), ofsDistance(12), deflateSync(content)]),
    Buffer.concat([sizeHeader(3, content.length + 1), deflateSync(content)]),
    Buffer.concat([sizeHeader(3, content.length), deflateSync(content), Buffer.from('padding')]),
    Buffer.concat([sizeHeader(3, content.length), deflateSync(content), deflateSync(content)])];
  for (const bytes of bad) {
    const input = record(bytes, expected); rejected(state => decodeCompanyGitPackedObject(input.bytes, input.entry, packIdentity, state, 0));
  }
  const valid = packed(3, content), cutoff = record(Buffer.from(valid.bytes.subarray(0, -1)), valid.entry.oid);
  rejected(state => decodeCompanyGitPackedObject(cutoff.bytes, cutoff.entry, packIdentity, state, 0));
});

test('packed compression bombs stop at the declared output bound and release all temporary reservations', () => {
  const bytes = Buffer.concat([sizeHeader(3, 1), deflateSync(Buffer.alloc(limits.objectBytes + 1, 120))]);
  const input = record(bytes, 'a'.repeat(40));
  const state = rejected(state => decodeCompanyGitPackedObject(input.bytes, input.entry, packIdentity, state, 0));
  assert.equal(state.snapshot().inflations, 1); assert.equal(state.snapshot().outputBytesCharged, 1);
  const declaredEmpty = record(Buffer.concat([sizeHeader(3, 0), deflateSync(Buffer.from('x'))]), oid('blob', Buffer.alloc(0)));
  const emptyFailure = rejected(state => decodeCompanyGitPackedObject(declaredEmpty.bytes, declaredEmpty.entry, packIdentity, state, 0));
  assert.equal(emptyFailure.snapshot().outputBytesCharged, 1);
  const oversized = Buffer.alloc(limits.encodedObjectBytes + 1);
  rejected(state => decodeCompanyGitPackedObject(oversized, { ...input.entry, length: oversized.length }, packIdentity, state, 0));
});

test('loose object validates canonical header, filename OID, complete zlib stream and the one-MiB content boundary', () => {
  for (const content of [Buffer.alloc(0), Buffer.from('synthetic loose content'), Buffer.alloc(limits.objectBytes, 120)]) {
    const state = budget(), input = loose('blob', content), result = decodeCompanyGitLooseObject(input, oid('blob', content), state, 0);
    assert.equal(result.type, 'blob'); assert.equal(result.offset, null); assert.equal(result.base, null);
    assert.deepEqual(result.bytes, content); assert.equal(result.encodedSha256, sha256(input));
    assert.equal(state.snapshot().inflationBytesActual, Buffer.byteLength(`blob ${content.length}\0`) + content.length);
    assertCompanyGitVerifiedObject(result, state, 0); state.releaseMemory(result.memoryLease); assert.equal(state.snapshot().liveMemoryBytes, 0);
  }
  const content = Buffer.from('loose'), expected = oid('blob', content);
  for (const raw of [Buffer.from('blob 05\0loose'), Buffer.from('blob -1\0loose'), Buffer.from('blob 4\0loose'),
    Buffer.from('blob 1048577\0loose'), Buffer.from('reserved 5\0loose'), Buffer.from('blob 5 without terminator'),
    Buffer.from('blob ' + '1'.repeat(124) + '\0loose'), Buffer.from([98, 108, 111, 98, 32, 255, 0])]) {
    rejected(state => decodeCompanyGitLooseObject(deflateSync(raw), expected, state, 0));
  }
  rejected(state => decodeCompanyGitLooseObject(loose('blob', content), 'b'.repeat(40), state, 0));
  for (const tail of [Buffer.from([0]), loose('blob', content)]) {
    rejected(state => decodeCompanyGitLooseObject(Buffer.concat([loose('blob', content), tail]), expected, state, 0));
  }
  rejected(state => decodeCompanyGitLooseObject(Buffer.alloc(limits.gitFileBytes + 1), expected, state, 0), 'COMPANY_GIT_RANGE_INVALID_BYTES');
  rejected(state => decodeCompanyGitLooseObject(deflateSync(Buffer.alloc(limits.objectBytes + limits.looseHeaderBytes + 1, 120)), expected, state, 0));
});

test('same-pack OFS and REF dependencies verify each base and resulting OID with only the final lease retained', () => {
  const baseText = Buffer.from('hello'), middleText = Buffer.from('hello!'), targetText = Buffer.from('hello!?');
  const base = packed(3, baseText), offset = base.entry.offset + base.entry.length;
  const middleDelta = Buffer.from([5, 6, 0x90, 5, 1, 33]);
  const middle = packed(6, middleDelta, oid('blob', middleText), offset, ofsDistance(offset - base.entry.offset));
  const targetDelta = Buffer.from([6, 7, 0x90, 6, 1, 63]);
  const target = refDelta(middle, targetDelta, targetText, middle.entry.offset + middle.entry.length);
  const { state, object } = resolve([base, middle, target]);
  assert.deepEqual(object.bytes, targetText); assert.equal(object.type, 'blob'); assert.equal(object.oid, target.entry.oid);
  assert.deepEqual(object.base, { kind: 'oid', oid: middle.entry.oid });
  assert.equal(state.snapshot().visitedObjects, 3); assert.equal(state.snapshot().peakDependencyDepth, 3);
  assert.equal(state.snapshot().inflations, 3); assert.equal(state.snapshot().reconstructionBytes, middleText.length + targetText.length);
  assert.equal(state.snapshot().liveMemoryBytes, targetText.length); assert.equal(state.snapshot().dependencyDepth, 0);
  state.releaseMemory(object.memoryLease); assert.equal(state.snapshot().liveMemoryBytes, 0);
  const forgedBase = packed(3, Buffer.from('other'), base.entry.oid, base.entry.offset);
  rejected(state => resolveCompanyGitPackedObjects([forgedBase, middle, target], target.entry.oid, packIdentity, state, 0));
  const forgedTarget = { ...target, entry: { ...target.entry, oid: 'b'.repeat(40) } };
  rejected(state => resolveCompanyGitPackedObjects([base, middle, forgedTarget], forgedTarget.entry.oid, packIdentity, state, 0), 'COMPANY_GIT_RANGE_INVALID_DELTA');
});

test('delta source/target sizes, opcode zero, truncated inserts and copy bounds fail before target allocation', () => {
  const base = packed(3, Buffer.from('hello')), target = Buffer.from('result');
  for (const commands of [Buffer.from([4, 6, 6, ...target]), Buffer.from([5, 6, 0]),
    Buffer.from([5, 6, 6, 65]), Buffer.from([5, 6, 0x91, 5, 1]), Buffer.from([5, 4, 0x90, 5]),
    Buffer.from([5, 6, 1, 65]), Buffer.from([5, ...varint(limits.objectBytes + 1)]),
    Buffer.from([5, 0x80, 0x80, 0x80, 0x80, 0]), Buffer.from([0x85, 0, 6, 6, ...target])]) {
    const delta = refDelta(base, commands, target, base.entry.offset + base.entry.length);
    const state = rejected(state => resolveCompanyGitPackedObjects([base, delta], delta.entry.oid, packIdentity, state, 0), 'COMPANY_GIT_RANGE_INVALID_DELTA');
    assert.equal(state.snapshot().reconstructionBytes, 0);
  }
});

test('delta copy-size zero means 65536 and multibyte OFS distances retain exact semantics', () => {
  const content = Buffer.alloc(65536, 120), target = Buffer.concat([content, Buffer.from('!')]);
  const base = packed(3, content), offset = 4096;
  const delta = packed(6, Buffer.from([...varint(content.length), ...varint(target.length), 0x80, 1, 33]),
    oid('blob', target), offset, ofsDistance(offset - base.entry.offset));
  const { state, object } = resolve([base, delta]); assert.deepEqual(object.bytes, target);
  state.releaseMemory(object.memoryLease); assert.equal(state.snapshot().liveMemoryBytes, 0);
});

test('missing, external, cyclic and overlapping same-pack records are rejected without fallback', () => {
  const base = packed(3, Buffer.from('x')), commands = Buffer.from([1, 2, 2, 120, 121]);
  const delta = refDelta(base, commands, Buffer.from('xy'), base.entry.offset + base.entry.length);
  rejected(state => resolveCompanyGitPackedObjects([delta], delta.entry.oid, packIdentity, state, 0), 'COMPANY_GIT_RANGE_INVALID_GRAPH');
  rejected(state => resolveCompanyGitPackedObjects([base, { ...delta, entry: { ...delta.entry, offset: 12 } }], delta.entry.oid,
    packIdentity, state, 0), 'COMPANY_GIT_RANGE_INVALID_GRAPH');
  const first = packed(7, Buffer.from([0, 0]), 'a'.repeat(40), 12, Buffer.from('b'.repeat(40), 'hex'));
  const second = packed(7, Buffer.from([0, 0]), 'b'.repeat(40), 12 + first.entry.length, Buffer.from('a'.repeat(40), 'hex'));
  rejected(state => resolveCompanyGitPackedObjects([first, second], second.entry.oid, packIdentity, state, 0), 'COMPANY_GIT_RANGE_INVALID_GRAPH');
  const ofs = packed(6, Buffer.from([0, 0]), 'c'.repeat(40), 512, ofsDistance(256));
  rejected(state => resolveCompanyGitPackedObjects([ofs], ofs.entry.oid, packIdentity, state, 0), 'COMPANY_GIT_RANGE_INVALID_GRAPH');
});

test('dependency depth includes the final object and cleanup preserves the first budget limit failure', () => {
  const chain = (count: number): CompanyGitPackedRecord[] => {
    const records = [packed(3, Buffer.from('x'))]; let content = Buffer.from('x');
    for (let index = 1; index < count; index++) {
      const previous = records.at(-1)!, next = Buffer.from('x'.repeat(index + 1));
      const commands = Buffer.from([...varint(content.length), ...varint(next.length), next.length, ...next]);
      records.push(refDelta(previous, commands, next, previous.entry.offset + previous.entry.length)); content = next;
    }
    return records;
  };
  const { state, object } = resolve(chain(32)); assert.equal(object.bytes.length, 32); assert.equal(state.snapshot().peakDependencyDepth, 32);
  state.releaseMemory(object.memoryLease);
  const excessive = chain(33), failed = rejected(state => resolveCompanyGitPackedObjects(excessive, excessive.at(-1)!.entry.oid,
    packIdentity, state, 0), 'COMPANY_GIT_RANGE_LIMIT');
  assert.equal(failed.snapshot().failureCode, 'COMPANY_GIT_RANGE_LIMIT');
});

test('verified output rejects mutation, forged handles and released leases before reuse', () => {
  const source = packed(3, Buffer.from('owned synthetic content'));
  for (const change of ['bytes', 'shape', 'released'] as const) {
    const state = budget(), result = decodeCompanyGitPackedObject(source.bytes, source.entry, packIdentity, state, 0);
    if (change === 'bytes') result.bytes[0] = result.bytes[0]! ^ 1;
    if (change === 'released') state.releaseMemory(result.memoryLease);
    assert.throws(() => assertCompanyGitVerifiedObject(change === 'shape' ? { ...result } : result, state, 0),
      { code: change === 'released' ? 'COMPANY_GIT_RANGE_INVALID_BUDGET' : 'COMPANY_GIT_RANGE_INVALID_OBJECT' });
    if (change !== 'released') state.releaseMemory(result.memoryLease);
    assert.equal(state.snapshot().liveMemoryBytes, 0);
  }
});

test('a second pass performs fresh decompression and shares the request output budget', () => {
  const source = packed(3, Buffer.from('two-pass synthetic content')), state = budget();
  const first = resolveCompanyGitPackedObjects([source], source.entry.oid, packIdentity, state, 0);
  state.releaseMemory(first.memoryLease); state.endPass(1); state.beginPass('verify', 2);
  const second = resolveCompanyGitPackedObjects([source], source.entry.oid, packIdentity, state, 2);
  assert.equal(state.snapshot().inflations, 2); assert.equal(state.snapshot().visitedObjects, 1);
  assert.equal(state.snapshot().inflationBytesActual, second.bytes.length * 2);
  state.releaseMemory(second.memoryLease); state.endPass(3); assert.equal(state.snapshot().phase, 'complete');
  assert.equal(state.snapshot().readCalls, 0); assert.equal(state.snapshot().metadataCalls, 0); assert.equal(state.snapshot().openDescriptors, 0);
});

test('direct packed decoding also enforces the shared unique-object limit before the next inflation', () => {
  for (const sameOffset of [true, false]) {
    const state = budget();
    for (let index = 0; index < limits.visitedObjects; index++) {
      const content = Buffer.from(`Synthetic object ${index}`), input = packed(3, content, oid('blob', content), sameOffset ? 12 : 12 + index * 256);
      const result = decodeCompanyGitPackedObject(input.bytes, input.entry, packIdentity, state, 0); state.releaseMemory(result.memoryLease);
    }
    const content = Buffer.from('Synthetic object beyond limit');
    const input = packed(3, content, oid('blob', content), sameOffset ? 12 : 12 + limits.visitedObjects * 256);
    assert.throws(() => decodeCompanyGitPackedObject(input.bytes, input.entry, packIdentity, state, 0), { code: 'COMPANY_GIT_RANGE_LIMIT' });
    assert.equal(state.snapshot().visitedObjects, limits.visitedObjects); assert.equal(state.snapshot().inflations, limits.visitedObjects);
    assert.equal(state.snapshot().liveMemoryBytes, 0); assert.equal(state.snapshot().failureCode, 'COMPANY_GIT_RANGE_LIMIT');
  }
});
