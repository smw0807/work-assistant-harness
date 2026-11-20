import type { CompanyChangeApprovalRequest, CompanyChangeDraft, CompanyChangePlan,
  CompanyChangePruneResult, CompanyChangeSnapshot } from '../domain/company-change.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';

/** Review-only storage cannot claim approvals or apply files and Git changes. */
export interface CompanyChangeStore {
  create(plan: CompanyChangePlan, draft: CompanyChangeDraft, context: ReadonlyContext): CompanyChangeSnapshot;
  inspect(id: string, context: ReadonlyContext): CompanyChangeSnapshot;
  review(id: string, context: ReadonlyContext): CompanyChangeSnapshot;
  approve(request: CompanyChangeApprovalRequest, context: ReadonlyContext): CompanyChangeSnapshot;
  cancel(id: string, context: ReadonlyContext): CompanyChangeSnapshot;
  prune(context: ReadonlyContext): CompanyChangePruneResult;
  close(): void;
}
