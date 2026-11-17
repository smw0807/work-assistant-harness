import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { CompanyReadonlyV2SourceAdapter } from '../src/adapters/company-readonly-v2-source.js';
import type { CompanyReadonlyPolicy } from '../src/domain/company-readonly.js';
import type { CompanyReadonlyRegistrationV2 } from '../src/domain/company-readonly-v2.js';
import { getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { createCompanyGitRangeFixture } from './company-readonly-git-range-fixture.js';

/** Creates only an independent synthetic fixture. No original repository path or external content is accepted. */
export const createCompanyReadonlyV2Fixture = async (testContext: TestContext, large = false) => {
  const fixture = await createCompanyGitRangeFixture(testContext, 'pack', large);
  const registration: CompanyReadonlyRegistrationV2 = { version: 'company-readonly-registration-v2',
    gitProfileHash: getCompanyGitRangeProfileHash(), repoId: 'company-range-test', sourceRoot: fixture.root,
    baseCommit: fixture.baseCommit, question: 'Explain only the selected synthetic evidence and identify missing context.',
    readRanges: [...fixture.selectedPaths].sort().map(path => ({ path, startLine: 1, endLine: 1 })),
    reviewPaths: [...fixture.selectedPaths].sort() };
  const policy: CompanyReadonlyPolicy = { version: 'company-readonly-policy-v1', enabled: false, readPermission: 'confirmed',
    storagePermission: 'confirmed', policyReference: 'synthetic-company-policy', payloadRetentionHours: 1, auditRetentionDays: 1 };
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-01-01T00:00:00.000Z') };
  const id = randomUUID(), source = new CompanyReadonlyV2SourceAdapter();
  const prepareInput = () => {
    const session = source.open(registration);
    try {
      const inspected = session.inspect(), verified = session.verify();
      return { registration, policy, observation: verified.observation, collected: inspected.collected,
        budget: verified.budget, context, id };
    } finally { session.close(); }
  };
  return { ...fixture, registration, policy, context, id, source, prepareInput };
};
