import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { CompanyReadonlyV3SourceAdapter } from '../src/adapters/company-readonly-v3-source.js';
import type { CompanyReadonlyPolicy } from '../src/domain/company-readonly.js';
import type { CompanyReadonlyRegistrationV3 } from '../src/domain/company-readonly-v3.js';
import { getCompanyGitRangeUnitProfileHash, getCompanyGitRangeUnitGuardPolicyHash } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyGitRangeFixture } from './company-readonly-git-range-fixture.js';

/** Creates only an independent synthetic fixture. No original repository path or external content is accepted. */
export const createCompanyReadonlyV3Fixture = async (testContext: TestContext, large = false) => {
  const fixture = await createCompanyGitRangeFixture(testContext, 'pack', large);
  const registration: CompanyReadonlyRegistrationV3 = { version: 'company-readonly-registration-v3',
    gitProfileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), repoId: 'company-range-test', sourceRoot: fixture.root,
    baseCommit: fixture.baseCommit, question: 'Explain only the selected synthetic evidence and identify missing context.',
    readRanges: [...fixture.selectedPaths].sort().map(path => ({ path, startLine: 1, endLine: 1 })),
    reviewPaths: [...fixture.selectedPaths].sort() };
  const policy: CompanyReadonlyPolicy = { version: 'company-readonly-policy-v1', enabled: false, readPermission: 'confirmed',
    storagePermission: 'confirmed', policyReference: 'synthetic-company-policy', payloadRetentionHours: 1, auditRetentionDays: 1 };
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-01-01T00:00:00.000Z') };
  const id = randomUUID(), source = new CompanyReadonlyV3SourceAdapter();
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
