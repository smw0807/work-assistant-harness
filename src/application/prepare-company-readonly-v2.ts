import type { CompanyReadonlyPruneResult } from '../domain/company-readonly.js';
import type { CompanyReadonlySnapshotV2, CompanyReadonlySourceV2, CompanyReadonlyStoreV2 } from '../domain/company-readonly-v2.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { assertCompanyReadonlyPolicyAllowed, parseCompanyReadonlyPolicy } from '../policy/company-readonly.js';
import { createCompanyReadonlyPreparationV2, parseCompanyReadonlyRegistrationV2 } from '../policy/company-readonly-v2.js';
import { assertReadonlyContext, isReadonlyId } from '../policy/readonly-investigation-policy.js';

/** The parent reserves the ID before this synchronous, two-pass preparation starts. */
export class CompanyReadonlyPreparationServiceV2 {
  constructor(private readonly store: CompanyReadonlyStoreV2, private readonly source: CompanyReadonlySourceV2) {}

  prepare(registration: unknown, policy: unknown, context: ReadonlyContext, id: string): CompanyReadonlySnapshotV2 {
    const declared = parseCompanyReadonlyPolicy(policy);
    assertCompanyReadonlyPolicyAllowed(declared);
    assertReadonlyContext(context); this.assertId(id);
    const registered = parseCompanyReadonlyRegistrationV2(registration);
    const captured = { ownerId: context.ownerId, now: new Date(context.now.getTime()) };
    const session = this.source.open(registered);
    let prepared;
    try {
      const inspected = session.inspect(), verified = session.verify();
      if (inspected.observation.proofHash !== verified.observation.proofHash) {
        throw new HarnessError('COMPANY_READONLY_V2_SOURCE_CHANGED');
      }
      prepared = createCompanyReadonlyPreparationV2(registered, declared, verified.observation,
        inspected.collected, verified.budget, captured, id);
    } finally { session.close(); }
    return this.store.create(prepared.plan, prepared.payload, captured);
  }

  inspect(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV2 {
    assertReadonlyContext(context); this.assertId(id); return this.store.inspect(id, context);
  }

  cancel(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV2 {
    assertReadonlyContext(context); this.assertId(id); return this.store.cancel(id, context);
  }

  prune(context: ReadonlyContext): CompanyReadonlyPruneResult {
    assertReadonlyContext(context); return this.store.prune(context);
  }

  private assertId(id: string): void {
    if (!isReadonlyId(id)) throw new HarnessError('COMPANY_READONLY_V2_INVALID_ID');
  }
}
