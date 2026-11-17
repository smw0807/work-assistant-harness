import type { CompanyReadonlyRegistrationV2, CompanyReadonlySessionV2, CompanyReadonlySourceV2 } from '../domain/company-readonly-v2.js';
import { parseCompanyReadonlyRegistrationV2 } from '../policy/company-readonly-v2.js';
import { createCompanyGitRangeCollectionSource } from './company-git-range-source.js';

/** Registration validation is pure. The application must confirm company policy before opening this source. */
export class CompanyReadonlyV2SourceAdapter implements CompanyReadonlySourceV2 {
  open(input: CompanyReadonlyRegistrationV2): CompanyReadonlySessionV2 {
    const registration = parseCompanyReadonlyRegistrationV2(input);
    const source = createCompanyGitRangeCollectionSource({ version: 'company-git-range-source-v1',
      profileHash: registration.gitProfileHash, sourceRoot: registration.sourceRoot, baseCommit: registration.baseCommit,
      selectedPaths: [...new Set(registration.readRanges.map(range => range.path))].sort() },
    { repoId: registration.repoId, readRanges: registration.readRanges });
    return Object.freeze({ inspect: source.inspect, verify: source.verify, close: source.close });
  }
}
Object.freeze(CompanyReadonlyV2SourceAdapter.prototype);
