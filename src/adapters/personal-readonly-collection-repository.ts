import { HarnessError } from '../domain/errors.js';
import type { PersonalCollectionEvidence, PersonalCollectionPayload, PersonalCollectionRegistration,
  PersonalSourceViewProof } from '../domain/personal-readonly-collection.js';
import type { PersonalReadonlyRegistration, PersonalReadonlyRepository } from '../domain/personal-readonly.js';
import { derivePersonalSourceView, extractPersonalCollectionEvidence, getPersonalCollectionProfile,
  getPersonalCollectionProfileHash } from '../policy/personal-readonly-collection.js';
import { parsePersonalCollectionRegistration } from '../policy/personal-readonly-collection-policy.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { createPersonalReadonlyCollectionReader } from './personal-readonly-repository.js';

const reject = (): never => { throw new HarnessError('PERSONAL_COLLECTION_SOURCE_CHANGED'); };
const same = (left: unknown, right: unknown): boolean => canonicalReadonlyJson(left) === canonicalReadonlyJson(right);
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return reject();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) return reject();
  return descriptor.value;
};
const copyData = <T>(value: T): T => {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 32768 || depth > 24) reject();
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && Buffer.byteLength(item) <= 131072) return item;
    if (!item || typeof item !== 'object') return reject();
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 4096 || Reflect.ownKeys(item).length !== item.length + 1) reject();
      return Array.from({ length: item.length }, (_, index) => visit(ownArray(item, String(index)), depth + 1));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) reject();
    return Object.fromEntries(Reflect.ownKeys(item).map((key) => {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return reject();
      return [key, visit(own(item, key), depth + 1)];
    }));
  };
  return visit(value, 0) as T;
};
const ownArray = (value: unknown[], key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) return reject(); return descriptor.value;
};
const coreRegistration = (input: PersonalCollectionRegistration): PersonalReadonlyRegistration => {
  const registration = parsePersonalCollectionRegistration(copyData(input));
  return { version: 'personal-readonly-registration-v1', repoId: registration.repoId, sourceRoot: registration.sourceRoot,
    baseCommit: registration.baseCommit, question: registration.question, readRanges: registration.readRanges, transferPaths: registration.transferPaths };
};
const collectionReader = (proofs?: Map<string, PersonalSourceViewProof>) => createPersonalReadonlyCollectionReader((repoId, baseCommit, range, bytes) => {
  const view = derivePersonalSourceView(range.path, bytes);
  const proof: PersonalSourceViewProof = { path: view.path, sourceHash: view.sourceHash, sourceBytes: view.sourceBytes, sourceLines: view.sourceLines,
    viewHash: view.viewHash, viewBytes: view.viewBytes, viewLines: view.viewLines, rawSensitiveCheck: view.rawSensitiveCheck,
    viewSensitiveCheck: view.viewSensitiveCheck, maskCount: view.maskCount, maskedLines: view.maskedLines };
  if (proofs?.has(range.path) && !same(proofs.get(range.path), proof)) reject();
  proofs?.set(range.path, proof);
  return extractPersonalCollectionEvidence(repoId, baseCommit, range, view);
});
export const inspectPersonalCollectionRepository = (registration: PersonalCollectionRegistration, id: string): Promise<PersonalReadonlyRepository> =>
  collectionReader().inspect(coreRegistration(registration), id);

const collectNow = (repository: PersonalReadonlyRepository, input: PersonalCollectionRegistration): PersonalCollectionEvidence => {
  try {
    const registration = coreRegistration(input), proofs = new Map<string, PersonalSourceViewProof>();
    const evidence = collectionReader(proofs).collectNow(repository, registration);
    const sourceViews = repository.readAllowedFiles.map((path) => {
      const proof = proofs.get(path); if (!proof) return reject(); return proof;
    });
    return { evidence, sourceViews };
  } catch { return reject(); }
};
export const collectPersonalCollectionEvidence = async (repository: PersonalReadonlyRepository, registration: PersonalCollectionRegistration): Promise<PersonalCollectionEvidence> =>
  collectNow(copyData(repository), registration);

/** Source proof is regenerated synchronously at credential and dispatch boundaries; transport/body validation remains a separate pure policy check. */
export const assertPersonalCollectionPayloadNow = (input: PersonalCollectionPayload): void => {
  try {
    const repository = copyData(own(input, 'repository')) as PersonalReadonlyRepository;
    const registration = copyData(own(input, 'registration')) as PersonalCollectionRegistration;
    const context = copyData(own(input, 'context')) as PersonalCollectionPayload['context'];
    const sourceViews = copyData(own(input, 'sourceViews')) as PersonalSourceViewProof[];
    if (!same(copyData(own(input, 'collectionProfile')), getPersonalCollectionProfile())
      || own(input, 'collectionProfileHash') !== getPersonalCollectionProfileHash()
      || own(input, 'sourceViewsHash') !== hashReadonlyValue(canonicalReadonlyJson(sourceViews))) reject();
    const collected = collectNow(repository, registration);
    if (!same(collected.sourceViews, sourceViews) || !same(collected.evidence, context.evidence)
      || context.repoId !== repository.repoId || context.baseCommit !== repository.baseCommit
      || context.sourceManifestHash !== repository.sourceManifestHash || !same(context.readAllowedFiles, repository.readAllowedFiles)
      || !same(context.readRanges, parsePersonalCollectionRegistration(registration).readRanges)) reject();
  } catch { reject(); }
};
export const assertPersonalCollectionPayload = async (payload: PersonalCollectionPayload): Promise<void> => { assertPersonalCollectionPayloadNow(payload); };
