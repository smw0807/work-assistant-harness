import type { CompanyInvestigationSourcePort } from '../domain/company-investigation.js';
import type { CompanyReadonlyPayloadV3, CompanyReadonlySourceV3 } from '../domain/company-readonly-v3.js';
import { HarnessError } from '../domain/errors.js';
import { assertCompanyReadonlyPolicyAllowed, parseCompanyReadonlyPolicy } from '../policy/company-readonly.js';
import { copyCompanyReadonlyV3Data } from '../policy/company-readonly-v3.js';
import { canonicalReadonlyJson } from '../policy/readonly-investigation-policy.js';
import { CompanyReadonlyV3SourceAdapter } from './company-readonly-v3-source.js';

/** Each verification opens a fresh bounded v3 session; no earlier preparation budget is reset or widened. */
export class CompanyInvestigationSourceAdapter implements CompanyInvestigationSourcePort {
  constructor(private readonly source: CompanyReadonlySourceV3 = new CompanyReadonlyV3SourceAdapter()) {}

  verify(input: CompanyReadonlyPayloadV3): void {
    const payload = copyCompanyReadonlyV3Data(input);
    assertCompanyReadonlyPolicyAllowed(parseCompanyReadonlyPolicy(payload.policy));
    const session = this.source.open(payload.registration);
    try {
      const inspected = session.inspect(), verified = session.verify();
      if (inspected.observation.proofHash !== verified.observation.proofHash
        || verified.observation.proofHash !== payload.observation.proofHash
        || canonicalReadonlyJson(inspected.collected) !== canonicalReadonlyJson(payload.collected)) {
        throw new HarnessError('COMPANY_INVESTIGATION_SOURCE_CHANGED');
      }
    } catch (error) {
      try { session.close(); } catch { /* A failed verification remains a failure even if closing also fails. */ }
      throw error;
    }
    // A matching observation is unusable until all source descriptors are confirmed closed.
    session.close();
  }
}
