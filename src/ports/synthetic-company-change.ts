import type { SyntheticCompanyChangeApprovalRequest, SyntheticCompanyChangeFailureCode,
  SyntheticCompanyChangeJournalEntry, SyntheticCompanyChangePlan, SyntheticCompanyChangeRequest,
  SyntheticCompanyChangeSnapshot } from '../domain/synthetic-company-change.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { CompanyChangeDraft } from '../domain/company-change.js';
import type { SyntheticCompanyChangeSource } from '../domain/synthetic-company-change.js';

/** Only metadata is persisted; the service must revalidate caller-supplied bodies before approval and claim. */
export interface SyntheticCompanyChangeStore {
  create(plan: SyntheticCompanyChangePlan, context: ReadonlyContext): SyntheticCompanyChangeSnapshot;
  inspect(id: string, context: ReadonlyContext): SyntheticCompanyChangeSnapshot;
  approve(request: SyntheticCompanyChangeApprovalRequest, context: ReadonlyContext): SyntheticCompanyChangeSnapshot;
  claim(request: SyntheticCompanyChangeRequest, context: ReadonlyContext): SyntheticCompanyChangeSnapshot;
  record(taskId: string, entry: Omit<SyntheticCompanyChangeJournalEntry, 'sequence' | 'at'>,
    context: ReadonlyContext): SyntheticCompanyChangeSnapshot;
  finish(taskId: string, status: 'APPLIED' | 'FAILED', failureCode: SyntheticCompanyChangeFailureCode | null,
    context: ReadonlyContext): SyntheticCompanyChangeSnapshot;
  cancel(id: string, context: ReadonlyContext): SyntheticCompanyChangeSnapshot;
  close(): void;
}

export interface SyntheticCompanyChangeWorkspacePort {
  observe(draft: CompanyChangeDraft): Promise<SyntheticCompanyChangeSource>;
  acquire(): Promise<{ release(): Promise<void> }>;
  createBranch(plan: SyntheticCompanyChangePlan, draft: CompanyChangeDraft): Promise<void>;
  writeFile(plan: SyntheticCompanyChangePlan, draft: CompanyChangeDraft, index: number): Promise<void>;
  verifyApplied(plan: SyntheticCompanyChangePlan, draft: CompanyChangeDraft): Promise<void>;
}
