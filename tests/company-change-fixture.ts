import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import { createCompanyChangePlan, hashCompanyChangeValue } from '../src/policy/company-change.js';

/** Declared synthetic values only. This fixture never creates or reads a repository. */
export const createCompanyChangeDraft = (): CompanyChangeDraft => ({
  version: 'company-change-draft-v1', repoId: 'synthetic-declared-repository', requestRevision: 1,
  objective: 'Review a declared synthetic replacement and a new synthetic test file.',
  baseCommit: '1'.repeat(40), baseBranch: 'main', baseIndexHash: '2'.repeat(64), workType: 'fix', branch: 'fix/synthetic-change',
  changes: [
    { operation: 'replace', path: 'src/value.ts', beforeHash: hashCompanyChangeValue("export const value = 'before';\n"), content: "export const value = 'after';\n" },
    { operation: 'create', path: 'tests/value.spec.ts', beforeHash: null, content: "export const expected = 'after';\n" },
  ],
});

export const createCompanyChangeFixture = (now = new Date('2026-01-01T00:00:00.000Z')) => {
  const context = { ownerId: `os-user:${process.getuid!()}`, now }, id = '11111111-1111-4111-8111-111111111111';
  return { ...createCompanyChangePlan(createCompanyChangeDraft(), context, id), context, id };
};
