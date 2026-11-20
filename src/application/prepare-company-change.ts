import type { CompanyChangeApprovalRequest, CompanyChangeSnapshot } from '../domain/company-change.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { HarnessError } from '../domain/errors.js';
import type { CompanyChangeStore } from '../ports/company-change.js';
import { assertCompanyChangeContext, createCompanyChangePlan } from '../policy/company-change.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';

/** Supplied repository metadata is a declaration; this review service has no source or execution port. */
export class CompanyChangePreparationService {
  constructor(private readonly store: CompanyChangeStore) {}

  prepare(input: unknown, context: ReadonlyContext, id: string): CompanyChangeSnapshot {
    this.validate(id, context);
    const prepared = createCompanyChangePlan(input, context, id);
    return this.store.create(prepared.plan, prepared.draft, context);
  }

  inspect(id: string, context: ReadonlyContext): CompanyChangeSnapshot {
    this.validate(id, context); return this.store.inspect(id, context);
  }

  review(id: string, context: ReadonlyContext): CompanyChangeSnapshot {
    this.validate(id, context); return this.store.review(id, context);
  }

  approve(request: CompanyChangeApprovalRequest, context: ReadonlyContext): CompanyChangeSnapshot {
    this.validate(request.taskId, context); return this.store.approve(request, context);
  }

  cancel(id: string, context: ReadonlyContext): CompanyChangeSnapshot {
    this.validate(id, context); return this.store.cancel(id, context);
  }

  prune(context: ReadonlyContext) {
    assertCompanyChangeContext(context); return this.store.prune(context);
  }

  private validate(id: string, context: ReadonlyContext): void {
    assertCompanyChangeContext(context);
    if (!isReadonlyId(id)) throw new HarnessError('COMPANY_CHANGE_INVALID_ID');
  }
}
