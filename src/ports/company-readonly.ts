import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { PersonalCollectionEvidence } from '../domain/personal-readonly-collection.js';
import type { CompanyReadonlyPayload, CompanyReadonlyPlan, CompanyReadonlyPruneResult,
  CompanyReadonlyRegistration, CompanyReadonlyRepository, CompanyReadonlySnapshot } from '../domain/company-readonly.js';

/** Preparation deliberately has no approval, credential, transmission or execution capability. */
export interface CompanyReadonlySourcePort {
  inspect(registration: CompanyReadonlyRegistration, id: string): Promise<CompanyReadonlyRepository>;
  collect(repository: CompanyReadonlyRepository, registration: CompanyReadonlyRegistration): Promise<PersonalCollectionEvidence>;
  assertUnchanged(payload: CompanyReadonlyPayload): void;
}
export interface CompanyReadonlyStore {
  create(plan: CompanyReadonlyPlan, payload: CompanyReadonlyPayload, context: ReadonlyContext): CompanyReadonlySnapshot;
  inspect(id: string, context: ReadonlyContext): CompanyReadonlySnapshot;
  cancel(id: string, context: ReadonlyContext): CompanyReadonlySnapshot;
  prune(context: ReadonlyContext): CompanyReadonlyPruneResult;
  close(): void;
}
