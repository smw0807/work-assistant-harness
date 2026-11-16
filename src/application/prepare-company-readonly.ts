import { randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { CompanyReadonlyPruneResult, CompanyReadonlySnapshot } from '../domain/company-readonly.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { CompanyReadonlySourcePort, CompanyReadonlyStore } from '../ports/company-readonly.js';
import { assertReadonlyContext, isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { assertCompanyReadonlyPolicyAllowed, createCompanyReadonlyPreparation, parseCompanyReadonlyPolicy,
  parseCompanyReadonlyRegistration } from '../policy/company-readonly.js';

/** Prepare only after an explicit local policy declaration; no approval, model or execution port exists. */
export class CompanyReadonlyPreparationService {
  constructor(private readonly store: CompanyReadonlyStore, private readonly sourcePort: CompanyReadonlySourcePort) {}

  async prepare(registration: unknown, policy: unknown, context: ReadonlyContext): Promise<CompanyReadonlySnapshot> {
    const declared = parseCompanyReadonlyPolicy(policy); assertCompanyReadonlyPolicyAllowed(declared);
    assertReadonlyContext(context);
    const registered = parseCompanyReadonlyRegistration(registration);
    const capturedContext = { ownerId: context.ownerId, now: new Date(context.now.getTime()) };
    const repository = await this.sourcePort.inspect(registered, randomUUID());
    const collected = await this.sourcePort.collect(repository, registered);
    const { plan, payload } = createCompanyReadonlyPreparation(registered, declared, repository, collected, capturedContext);
    this.sourcePort.assertUnchanged(payload);
    return this.store.create(plan, payload, capturedContext);
  }

  inspect(id: string, context: ReadonlyContext): CompanyReadonlySnapshot {
    assertReadonlyContext(context); this.assertId(id); return this.store.inspect(id, context);
  }

  cancel(id: string, context: ReadonlyContext): CompanyReadonlySnapshot {
    assertReadonlyContext(context); this.assertId(id); return this.store.cancel(id, context);
  }

  prune(context: ReadonlyContext): CompanyReadonlyPruneResult {
    assertReadonlyContext(context); return this.store.prune(context);
  }

  private assertId(id: string): void {
    if (!isReadonlyId(id)) throw new HarnessError('COMPANY_READONLY_INVALID_ID');
  }
}
