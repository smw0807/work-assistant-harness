import type { CompanyReadonlyPolicy, CompanyReadonlyRepository } from '../src/domain/company-readonly.js';
import type { PersonalCollectionEvidence, PersonalSourceViewProof } from '../src/domain/personal-readonly-collection.js';
import type { ReadonlyContext, ReadonlyEntryIdentity } from '../src/domain/readonly-investigation.js';
import { createCompanyReadonlyPreparation, parseCompanyReadonlyRegistration } from '../src/policy/company-readonly.js';
import { derivePersonalSourceView, extractPersonalCollectionEvidence } from '../src/policy/personal-readonly-collection.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

interface FixtureOptions {
  id?: string;
  context?: ReadonlyContext;
  question?: string;
  sourceText?: string;
  policy?: CompanyReadonlyPolicy;
}

/** Pure synthetic fixture: no repository, credential file or external process is accessed. */
export const companyReadonlyFixture = (options: FixtureOptions = {}) => {
  const digest = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));
  const policy: CompanyReadonlyPolicy = options.policy ?? { version: 'company-readonly-policy-v1', enabled: false,
    readPermission: 'confirmed', storagePermission: 'confirmed', policyReference: 'synthetic-policy-reference',
    payloadRetentionHours: 4, auditRetentionDays: 2 };
  const registration = parseCompanyReadonlyRegistration({ version: 'company-readonly-registration-v1',
    repoId: 'company-fixture', sourceRoot: '/synthetic/company-source', baseCommit: 'a'.repeat(40),
    question: options.question ?? 'Explain only the visible entry; identify missing evidence.',
    readRanges: [{ path: 'src/entry.ts', startLine: 1, endLine: 1 }, { path: 'src/unused.ts', startLine: 1, endLine: 1 }],
    reviewPaths: ['src/entry.ts'] });
  const sources = { 'src/entry.ts': options.sourceText ?? "export const entry = () => 'synthetic';\n",
    'src/unused.ts': "export const outsideReview = 'SYNTHETIC_UNSELECTED';\n" };
  const manifest: ReadonlyEntryIdentity[] = Object.entries(sources).map(([path, text], index) => ({ path, kind: 'file',
    hash: hashReadonlyValue(text), size: Buffer.byteLength(text), mode: 0o100644, device: 1, inode: index + 10,
    links: 1, uid: process.getuid!(), modified: '1', changed: '1' }));
  const fields: Omit<CompanyReadonlyRepository, 'identityHash'> = { id: options.id ?? '11111111-1111-4111-8111-111111111111',
    kind: 'company-git', repoId: registration.repoId, sourceRoot: registration.sourceRoot, baseCommit: registration.baseCommit,
    sourceManifestHash: digest(manifest.map(({ path, hash, size, mode }) => ({ path, hash, size, mode }))),
    manifest, parents: [], readAllowedFiles: Object.keys(sources), gitEntries: [], headRef: 'refs/heads/main' };
  const repository = { ...fields, identityHash: digest(fields) };
  const views = Object.entries(sources).map(([path, text]) => derivePersonalSourceView(path, Buffer.from(text)));
  const collected: PersonalCollectionEvidence = { evidence: registration.readRanges.map(range =>
    extractPersonalCollectionEvidence(repository.repoId, repository.baseCommit, range, views.find(view => view.path === range.path)!)),
  sourceViews: views.map(view => Object.fromEntries(Object.entries(view).filter(([key]) => key !== 'bytes')) as unknown as PersonalSourceViewProof) };
  const context = options.context ?? { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-11-16T00:00:00.000Z') };
  return { registration, policy, repository, collected, context,
    ...createCompanyReadonlyPreparation(registration, policy, repository, collected, context) };
};
