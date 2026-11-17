import type { CompanyReadonlyRegistrationV3, CompanyReadonlySessionV3, CompanyReadonlySourceV3 } from '../domain/company-readonly-v3.js';
import { parseCompanyReadonlyRegistrationV3 } from '../policy/company-readonly-v3.js';
import { createCompanyGitRangeUnitCollectionSource } from './company-git-range-unit-source.js';

/** Registration validation is pure. The application must confirm company policy before opening this source. */
export class CompanyReadonlyV3SourceAdapter implements CompanyReadonlySourceV3 {
  open(input: CompanyReadonlyRegistrationV3): CompanyReadonlySessionV3 {
    const registration = parseCompanyReadonlyRegistrationV3(input);
    const source = createCompanyGitRangeUnitCollectionSource({ version: 'company-git-range-source-v2',
      profileHash: registration.gitProfileHash, guardPolicyHash: registration.guardPolicyHash, sourceRoot: registration.sourceRoot, baseCommit: registration.baseCommit,
      selectedPaths: [...new Set(registration.readRanges.map(range => range.path))].sort() },
    { repoId: registration.repoId, readRanges: registration.readRanges });
    return Object.freeze({ inspect: source.inspect, verify: source.verify, close: source.close });
  }
}
Object.freeze(CompanyReadonlyV3SourceAdapter.prototype);
