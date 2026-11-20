import { join } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { createCompanyGitRangeApplySource } from './company-git-range-unit-source.js';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../policy/company-git-range-unit-budget.js';
import { getCompanyApplyLimits, parseCompanyApplyDraft, parseCompanyApplyRegistration } from '../policy/company-apply.js';

export interface CompanyApplyGitProof {
  readonly proofHash: string;
  readonly packedRefsHash: string | null;
  readonly baseRefKind: 'loose' | 'packed';
  readonly readPaths: string[];
  readonly metadataPaths: string[];
  readonly readDirectories: string[];
}
const fail: (suffix: string) => never = suffix => { throw new HarnessError(`COMPANY_APPLY_${suffix}`); };
const unique = (paths: string[]): string[] => [...new Set(paths)].sort();

/** A selected-chain proof, not an inventory or full pack checksum. It never returns object or working-tree bodies. */
export const inspectCompanyApplyGit = async (registrationInput: unknown, draftInput: unknown): Promise<CompanyApplyGitProof> => {
  const registration = parseCompanyApplyRegistration(registrationInput), draft = parseCompanyApplyDraft(draftInput, registration);
  const source = createCompanyGitRangeApplySource({ version: 'company-git-range-apply-source-v1',
    profileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(),
    sourceRoot: registration.sourceRoot, baseCommit: registration.baseCommit, baseBranch: registration.baseBranch,
    targetBranch: draft.branch, selectedPaths: draft.changes.filter(change => change.operation === 'replace').map(change => change.path),
    absentPaths: draft.changes.filter(change => change.operation === 'create').map(change => change.path) });
  try {
    const first = source.inspect(), verified = source.verify();
    if (first.proofHash !== verified.proofHash || source.snapshot().completedPasses !== 2) fail('GIT_PROOF_CHANGED');
    if (verified.workingIndexHash !== registration.baseIndexHash) fail('GIT_PROOF_MISMATCH');
    let beforeBytes = 0;
    for (const change of draft.changes) {
      if (change.operation === 'create') {
        if (!verified.absentPaths.includes(change.path) || !verified.fileSystem.absentPaths.includes(change.path)) fail('GIT_PROOF_MISMATCH');
      } else {
        const selected = verified.selectedFiles.find(file => file.path === change.path);
        if (!selected || selected.sha256 !== change.beforeHash || selected.mode !== '100644') fail('GIT_PROOF_MISMATCH');
        beforeBytes += selected.bytes;
      }
    }
    if (beforeBytes > getCompanyApplyLimits().maxTotalContentBytes) fail('GIT_PROOF_MISMATCH');
    const fileSystem = verified.fileSystem, root = registration.sourceRoot;
    const index = fileSystem.files.find(file => file.path === '.git/index');
    if (!index || index.size > getCompanyApplyLimits().maxIndexBytes) fail('GIT_PROOF_MISMATCH');
    const readPaths = unique(fileSystem.files.map(file => join(root, file.path)));
    const metadataPaths = unique([...fileSystem.parents.map(parent => parent.path), ...readPaths,
      ...fileSystem.absentPaths.map(path => join(root, path)), ...fileSystem.missingParents.map(path => join(root, path))]);
    const packDirectory = join(root, '.git/objects/pack');
    const readDirectories = fileSystem.parents.some(parent => parent.path === packDirectory) ? [packDirectory] : [];
    if (readPaths.length > 128 || metadataPaths.length > 128) fail('GIT_PROOF_PATH_LIMIT');
    return { proofHash: verified.proofHash, packedRefsHash: verified.packedRefsHash, baseRefKind: verified.baseRefKind,
      readPaths, metadataPaths, readDirectories };
  } finally { source.close(); }
};
