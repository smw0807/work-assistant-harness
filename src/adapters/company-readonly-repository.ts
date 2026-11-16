import { HarnessError } from '../domain/errors.js';
import type { CompanyReadonlyPayload, CompanyReadonlyRegistration, CompanyReadonlyRepository } from '../domain/company-readonly.js';
import { PERSONAL_COLLECTION_PLAN_POLICY, PERSONAL_COLLECTION_POLICY,
  type PersonalCollectionEvidence, type PersonalCollectionPayload, type PersonalCollectionRegistration } from '../domain/personal-readonly-collection.js';
import type { PersonalReadonlyRepository } from '../domain/personal-readonly.js';
import type { CompanyReadonlySourcePort } from '../ports/company-readonly.js';
import { copyCompanyReadonlyData, parseCompanyReadonlyRegistration } from '../policy/company-readonly.js';
import { getPersonalCollectionProfile, getPersonalCollectionProfileHash } from '../policy/personal-readonly-collection.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { assertPersonalCollectionPayloadNow, collectPersonalCollectionEvidence,
  inspectPersonalCollectionRepository } from './personal-readonly-collection-repository.js';

const changed = (): never => { throw new HarnessError('COMPANY_READONLY_SOURCE_CHANGED'); };
const hash = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));

/** This projection selects the existing source collector; it creates no personal plan or transport input. */
const sourceRegistration = (value: CompanyReadonlyRegistration): PersonalCollectionRegistration => {
  const registration = parseCompanyReadonlyRegistration(value);
  return { version: 'personal-readonly-registration-v2', collectionPolicy: PERSONAL_COLLECTION_POLICY,
    repoId: registration.repoId, sourceRoot: registration.sourceRoot, baseCommit: registration.baseCommit,
    question: registration.question, readRanges: registration.readRanges, transferPaths: registration.reviewPaths };
};
const companyRepository = (repository: PersonalReadonlyRepository): CompanyReadonlyRepository => {
  const { identityHash, ...fields } = repository;
  if (repository.kind !== 'personal-git' || identityHash !== hash(fields)) return changed();
  const company = { ...fields, kind: 'company-git' as const };
  return { ...company, identityHash: hash(company) };
};
const sourceRepository = (value: CompanyReadonlyRepository): PersonalReadonlyRepository => {
  const repository = copyCompanyReadonlyData(value);
  const { identityHash, ...fields } = repository;
  if (repository.kind !== 'company-git' || identityHash !== hash(fields)) return changed();
  const source = { ...fields, kind: 'personal-git' as const };
  return { ...source, identityHash: hash(source) };
};

/** Company preparation reuses only the bounded Git reader, safe-view collector and synchronous source guard. */
export class CompanyReadonlyRepositoryAdapter implements CompanyReadonlySourcePort {
  async inspect(registration: CompanyReadonlyRegistration, id: string): Promise<CompanyReadonlyRepository> {
    const source = sourceRegistration(registration);
    try { return companyRepository(await inspectPersonalCollectionRepository(source, id)); }
    catch { return changed(); }
  }

  async collect(repository: CompanyReadonlyRepository, registration: CompanyReadonlyRegistration): Promise<PersonalCollectionEvidence> {
    const source = sourceRegistration(registration);
    try { return await collectPersonalCollectionEvidence(sourceRepository(repository), source); }
    catch { return changed(); }
  }

  assertUnchanged(value: CompanyReadonlyPayload): void {
    try {
      const payload = copyCompanyReadonlyData(value);
      const repository = sourceRepository(payload.repository), registration = sourceRegistration(payload.registration);
      const context = { policy: PERSONAL_COLLECTION_PLAN_POLICY, repoId: repository.repoId,
        baseCommit: repository.baseCommit, sourceManifestHash: repository.sourceManifestHash,
        readAllowedFiles: repository.readAllowedFiles, readRanges: registration.readRanges, evidence: payload.collected.evidence };
      const sourceView = { repository, registration, context: { ...context, contextHash: hash(context) },
        sourceViews: payload.collected.sourceViews, sourceViewsHash: hash(payload.collected.sourceViews),
        collectionProfile: getPersonalCollectionProfile(), collectionProfileHash: getPersonalCollectionProfileHash() };
      // The existing guard reads only these source fields. No body, credential, relay config or live plan is constructed.
      assertPersonalCollectionPayloadNow(sourceView as PersonalCollectionPayload);
    } catch { changed(); }
  }
}
