import type { CompanyReadonlyPruneResult } from '../domain/company-readonly.js';
import type { CompanyReadonlySnapshotV3, CompanyReadonlySourceV3, CompanyReadonlyStoreV3 } from '../domain/company-readonly-v3.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { assertCompanyReadonlyPolicyAllowed, parseCompanyReadonlyPolicy } from '../policy/company-readonly.js';
import { createCompanyReadonlyPreparationV3, parseCompanyReadonlyRegistrationV3 } from '../policy/company-readonly-v3.js';
import { assertReadonlyContext, isReadonlyId } from '../policy/readonly-investigation-policy.js';

/** The parent reserves the ID before this synchronous, two-pass preparation starts. */
export class CompanyReadonlyPreparationServiceV3 {
  constructor(private readonly store: CompanyReadonlyStoreV3, private readonly source: CompanyReadonlySourceV3) {}

  prepare(registration: unknown, policy: unknown, context: ReadonlyContext, id: string): CompanyReadonlySnapshotV3 {
    const declared = parseCompanyReadonlyPolicy(policy);
    assertCompanyReadonlyPolicyAllowed(declared);
    assertReadonlyContext(context); this.assertId(id);
    const registered = parseCompanyReadonlyRegistrationV3(registration);
    const captured = { ownerId: context.ownerId, now: new Date(context.now.getTime()) };
    const session = this.source.open(registered);
    let prepared;
    try {
      const inspected = session.inspect(), verified = session.verify();
      if (inspected.observation.proofHash !== verified.observation.proofHash) {
        throw new HarnessError('COMPANY_READONLY_V3_SOURCE_CHANGED');
      }
      prepared = createCompanyReadonlyPreparationV3(registered, declared, verified.observation,
        inspected.collected, verified.budget, captured, id);
    } catch (error) {
      try { session.close(); } catch { /* Preserve the first failure and any issued reader diagnostic. */ }
      throw error;
    }
    // Even a fully verified preparation cannot be persisted while source cleanup is uncertain.
    session.close();
    return this.store.create(prepared.plan, prepared.payload, captured);
  }

  inspect(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV3 {
    assertReadonlyContext(context); this.assertId(id); return this.store.inspect(id, context);
  }

  cancel(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV3 {
    assertReadonlyContext(context); this.assertId(id); return this.store.cancel(id, context);
  }

  prune(context: ReadonlyContext): CompanyReadonlyPruneResult {
    assertReadonlyContext(context); return this.store.prune(context);
  }

  private assertId(id: string): void {
    if (!isReadonlyId(id)) throw new HarnessError('COMPANY_READONLY_V3_INVALID_ID');
  }
}
