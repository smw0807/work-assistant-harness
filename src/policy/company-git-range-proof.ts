import { HarnessError } from '../domain/errors.js';
import { getCompanyGitRangeProfile, getCompanyGitRangeProfileHash } from './company-git-range-budget.js';
import { canonicalReadonlyJson, hashReadonlyValue, readonlyExactKeys } from './readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from './readonly-transport-protocol.js';
import type { CompanyGitRangePackMetadata } from './company-git-range-index.js';

export const COMPANY_GIT_RANGE_PROOF_BYTES = 128 * 1024;
export interface CompanyGitRangeObjectProof {
  readonly oid: string;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  readonly encoding: 'full' | 'ofs-delta' | 'ref-delta';
  readonly offset: number;
  readonly length: number;
  readonly crc32: number;
  readonly spanSha256: string;
  readonly contentSha256: string;
  readonly baseOid: string | null;
}
export interface CompanyGitRangeByteProof {
  readonly version: 'company-git-range-byte-proof-v1';
  readonly profileHash: string;
  readonly integrityScope: 'selected-object-chain';
  readonly packChecksum: 'not_checked';
  readonly unvisitedObjects: 'not_checked';
  readonly pack: CompanyGitRangePackMetadata;
  readonly rootOids: readonly string[];
  readonly objects: readonly CompanyGitRangeObjectProof[];
  readonly proofHash: string;
}
const limits = getCompanyGitRangeProfile().limits;
const reject = (): never => { throw new HarnessError('COMPANY_GIT_RANGE_INVALID_PROOF'); };
const hex = (value: unknown, length: number): value is string => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/u.test(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
const digest = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));
const keys = ['version', 'profileHash', 'integrityScope', 'packChecksum', 'unvisitedObjects', 'pack', 'rootOids', 'objects', 'proofHash'];
const packKeys = ['indexSha256', 'declaredPackChecksum', 'objectCount', 'packBytes', 'version', 'integrityScope', 'packChecksum', 'unvisitedObjects'];
const objectKeys = ['oid', 'type', 'encoding', 'offset', 'length', 'crc32', 'spanSha256', 'contentSha256', 'baseOid'];

const validateBody = (input: unknown): Pick<CompanyGitRangeByteProof, 'pack' | 'rootOids' | 'objects'> => {
  if (!readonlyExactKeys(input, ['pack', 'rootOids', 'objects'])) return reject();
  const { pack, rootOids, objects } = input as Pick<CompanyGitRangeByteProof, 'pack' | 'rootOids' | 'objects'>;
  if (!readonlyExactKeys(pack, packKeys) || !hex(pack.indexSha256, 64) || !hex(pack.declaredPackChecksum, 40)
    || !integer(pack.objectCount, 1, limits.indexObjects) || !integer(pack.packBytes, 33, limits.packBytes)
    || ![2, 3].includes(pack.version) || pack.integrityScope !== 'selected-object-chain'
    || pack.packChecksum !== 'not_checked' || pack.unvisitedObjects !== 'not_checked'
    || !Array.isArray(rootOids) || rootOids.length < 1 || rootOids.length > limits.visitedObjects
    || !Array.isArray(objects) || objects.length < 1 || objects.length > Math.min(limits.visitedObjects, pack.objectCount)) reject();
  if (rootOids.some((oid, index) => !hex(oid, 40) || index > 0 && rootOids[index - 1]! >= oid)) reject();
  const byOid = new Map<string, CompanyGitRangeObjectProof>();
  for (const [index, object] of objects.entries()) {
    if (!readonlyExactKeys(object, objectKeys) || !hex(object.oid, 40) || byOid.has(object.oid)
      || !['commit', 'tree', 'blob', 'tag'].includes(object.type) || !['full', 'ofs-delta', 'ref-delta'].includes(object.encoding)
      || !integer(object.offset, 12, pack.packBytes - 21) || !integer(object.length, 1, limits.encodedObjectBytes)
      || object.length > pack.packBytes - 20 - object.offset || !integer(object.crc32, 0, 0xffffffff)
      || !hex(object.spanSha256, 64) || !hex(object.contentSha256, 64)
      || (object.encoding === 'full' ? object.baseOid !== null : !hex(object.baseOid, 40))
      || index > 0 && objects[index - 1]!.offset + objects[index - 1]!.length > object.offset) reject();
    byOid.set(object.oid, object);
  }
  const reached = new Set<string>();
  for (const root of rootOids) {
    const chain = new Set<string>(); let oid: string | null = root;
    while (oid !== null) {
      const object = byOid.get(oid);
      if (!object || chain.has(oid) || chain.size >= limits.dependencyNodes) return reject();
      chain.add(oid); reached.add(oid);
      if (object.baseOid !== null) {
        const base = byOid.get(object.baseOid);
        if (!base || base.type !== object.type || object.encoding === 'ofs-delta' && base.offset >= object.offset) reject();
      }
      oid = object.baseOid;
    }
  }
  if (reached.size !== objects.length) reject();
  return { pack: Object.freeze({ ...pack }), rootOids: Object.freeze([...rootOids]),
    objects: Object.freeze(objects.map(object => Object.freeze({ ...object }))) };
};

/** Metadata consistency only: these hashes do not authenticate an observation or grant filesystem access. */
export const createCompanyGitRangeByteProof = (bodyJson: string): CompanyGitRangeByteProof => {
  try {
    const body = validateBody(parseReadonlyTransportJson(bodyJson, COMPANY_GIT_RANGE_PROOF_BYTES));
    const fields = { version: 'company-git-range-byte-proof-v1' as const, profileHash: getCompanyGitRangeProfileHash(),
      integrityScope: 'selected-object-chain' as const, packChecksum: 'not_checked' as const, unvisitedObjects: 'not_checked' as const, ...body };
    const proof = Object.freeze({ ...fields, proofHash: digest(fields) });
    if (Buffer.byteLength(canonicalReadonlyJson(proof)) > COMPANY_GIT_RANGE_PROOF_BYTES) reject();
    return proof;
  } catch { return reject(); }
};

export const parseCompanyGitRangeByteProof = (proofJson: string): CompanyGitRangeByteProof => {
  try {
    const proof = parseReadonlyTransportJson(proofJson, COMPANY_GIT_RANGE_PROOF_BYTES) as CompanyGitRangeByteProof;
    if (!readonlyExactKeys(proof, keys) || proof.version !== 'company-git-range-byte-proof-v1'
      || proof.profileHash !== getCompanyGitRangeProfileHash() || proof.integrityScope !== 'selected-object-chain'
      || proof.packChecksum !== 'not_checked' || proof.unvisitedObjects !== 'not_checked' || !hex(proof.proofHash, 64)) reject();
    const { proofHash, ...fields } = proof;
    if (digest(fields) !== proofHash) reject();
    const recreated = createCompanyGitRangeByteProof(canonicalReadonlyJson({ pack: proof.pack, rootOids: proof.rootOids, objects: proof.objects }));
    if (recreated.proofHash !== proofHash) reject();
    return recreated;
  } catch { return reject(); }
};
