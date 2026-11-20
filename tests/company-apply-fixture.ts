import type { CompanyApplyRegistration, CompanyApplySource } from '../src/domain/company-apply.js';
import { createCompanyApplyApproval, createCompanyApplyPlan, hashCompanyApplyValue } from '../src/policy/company-apply.js';
import { createCompanyChangeDraft } from './company-change-fixture.js';

/** Pure declared metadata and synthetic bodies; no source repository is read or created. */
export const createCompanyApplyFixture = (now = new Date('2026-01-01T00:00:00.000Z')) => {
  const draft = createCompanyChangeDraft();
  const registration: CompanyApplyRegistration = { version: 'company-write-registration-v1', repoId: draft.repoId,
    sourceRoot: '/private/tmp/declared-only-company-apply-example/repository', baseBranch: draft.baseBranch,
    baseCommit: draft.baseCommit, baseIndexHash: draft.baseIndexHash, writeAllowedFiles: draft.changes.map(change => change.path),
    enabled: true, localRead: 'allowed', localWrite: 'allowed' };
  const source: CompanyApplySource = { workspace: { rootIdentityHash: '3'.repeat(64),
    headHash: hashCompanyApplyValue('ref: refs/heads/main\n'), indexHash: registration.baseIndexHash,
    baseRefHash: hashCompanyApplyValue(`${registration.baseCommit}\n`), files: draft.changes.map(change => ({
      path: change.path, beforeHash: change.beforeHash, mode: change.operation === 'replace' ? 0o644 : null,
      identityHash: change.operation === 'replace' ? '4'.repeat(64) : null, parentIdentityHash: '5'.repeat(64),
    })) }, packedRefsHash: null, baseRefKind: 'loose', gitProofHash: '6'.repeat(64) };
  const context = { ownerId: `os-user:${process.getuid!()}`, now }, id = '11111111-1111-4111-8111-111111111111';
  const { plan } = createCompanyApplyPlan(draft, registration, source, context, id);
  const approval = createCompanyApplyApproval(plan, { taskId: id, planHash: plan.planHash, expiresInMinutes: 10 }, context);
  return { draft, registration, source, context, id, plan, approval };
};
