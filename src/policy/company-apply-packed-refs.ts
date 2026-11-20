import { types } from 'node:util';
import { HarnessError } from '../domain/errors.js';

export const COMPANY_APPLY_PACKED_REFS_MAX_BYTES = 1_048_576;
export interface CompanyApplyPackedRef { readonly ref: string; readonly oid: string; readonly peeledOid: string | null }
const fail: () => never = () => { throw new HarnessError('COMPANY_APPLY_INVALID_PACKED_REFS'); };
const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const lengthOf = Object.getOwnPropertyDescriptor(prototype, 'byteLength')!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')!.get!;
const bufferOf = Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!;
const arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const refName = (value: string): boolean => value.length <= 512 && /^refs\/[A-Za-z0-9_./-]+$/u.test(value)
  && !value.includes('..') && value.split('/').every(part => part.length > 0 && part.length <= 255
    && !part.startsWith('.') && !part.endsWith('.') && !part.toLowerCase().endsWith('.lock'));

/** Fixed apply-only bound. Comments and peeled metadata never become commands or repository paths. */
export const parseCompanyApplyPackedRefs = (input: Uint8Array): readonly CompanyApplyPackedRef[] => {
  try {
    if (types.isProxy(input) || !ArrayBuffer.isView(input) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))) fail();
    for (const key of ['length', 'byteLength', 'byteOffset', 'buffer', 'constructor', 'valueOf', 'toString', Symbol.iterator]) if (Object.hasOwn(input, key)) fail();
    const length = lengthOf.call(input) as number, offset = offsetOf.call(input) as number, backing = bufferOf.call(input) as ArrayBuffer;
    arrayLength.call(backing);
    if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype || resizable?.call(backing)
      || length > COMPANY_APPLY_PACKED_REFS_MAX_BYTES) fail();
    // The caller retains its bounded ordinary buffer for this synchronous parse; a view adds no unaccounted backing allocation.
    const bytes = new Uint8Array(backing, offset, length);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text !== '' && !text.endsWith('\n')) fail();
    for (const character of text) {
      const code = character.codePointAt(0)!;
      if (code < 9 || code > 10 && code < 32 || code === 127) fail();
    }
    const result: Array<{ ref: string; oid: string; peeledOid: string | null }> = [], names = new Set<string>();
    let previous: typeof result[number] | undefined, sorted = false, priorRef = '';
    for (const line of text ? text.slice(0, -1).split('\n') : []) {
      if (line.startsWith('#')) {
        if (line.startsWith('# pack-refs with:')) {
          const flags = line.slice('# pack-refs with:'.length).trim().split(/ +/u).filter(Boolean);
          if (flags.some(flag => !['peeled', 'fully-peeled', 'sorted'].includes(flag)) || new Set(flags).size !== flags.length) fail();
          if (result.length) fail(); sorted ||= flags.includes('sorted');
        }
        previous = undefined; continue;
      }
      if (/^\^[a-f0-9]{40}$/u.test(line)) {
        if (!previous || previous.peeledOid !== null) fail();
        previous.peeledOid = line.slice(1); previous = undefined; continue;
      }
      const entry = /^([a-f0-9]{40}) (refs\/[A-Za-z0-9_./-]+)$/u.exec(line);
      if (!entry || !refName(entry[2]!) || entry[1] === '0'.repeat(40)) fail();
      const ref = entry[2]!, folded = ref.toLowerCase();
      if (names.has(folded) || sorted && priorRef >= ref) fail();
      names.add(folded); priorRef = ref;
      previous = { ref, oid: entry[1]!, peeledOid: null }; result.push(previous);
    }
    for (const name of names) {
      const parts = name.split('/');
      for (let count = 1; count < parts.length; count++) if (names.has(parts.slice(0, count).join('/'))) fail();
    }
    return Object.freeze(result.map(entry => Object.freeze(entry)));
  } catch { return fail(); }
};
