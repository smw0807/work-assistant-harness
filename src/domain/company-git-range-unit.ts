import type { CompanyGitRangeBudgetSnapshot, CompanyGitRangeProfile } from './company-git-range.js';
import type { CompanyGitRangeFailure } from './company-git-range-diagnostic.js';

export const COMPANY_GIT_RANGE_UNIT_POLICY = 'company-git-range-reader-v2' as const;
export const COMPANY_GIT_RANGE_UNIT_GUARD_POLICY = 'company-git-range-read-unit-guard-v1' as const;
export const COMPANY_GIT_RANGE_UNIT_KINDS = Object.freeze([
  'pack-index', 'git-file', 'selected-file', 'pack-object', 'pack-header', 'pack-trailer',
] as const);
export type CompanyGitRangeUnitKind = typeof COMPANY_GIT_RANGE_UNIT_KINDS[number];
export interface CompanyGitRangeUnitDefinition {
  readonly scope: 'whole-file' | 'encoded-span' | 'fixed-span';
  readonly maximumBytes: number;
  readonly fixedBytes?: 12 | 20;
}
export interface CompanyGitRangeUnitGuardPolicy {
  readonly policy: typeof COMPANY_GIT_RANGE_UNIT_GUARD_POLICY;
  readonly units: Readonly<Record<CompanyGitRangeUnitKind, CompanyGitRangeUnitDefinition>>;
  readonly fullPathChecks: readonly ['open-before', 'open-after', 'unit-before', 'unit-after', 'pass-final'];
  readonly chunkLeafAndDescriptorChecks: readonly ['before-read', 'after-read'];
  readonly chunkMaximumBytes: number;
  readonly unitSelection: 'trusted-reader-fixed-units-only';
  readonly resultDelivery: 'after-unit-final-guard';
  readonly emptyFileRead: 'one-charged-zero-byte-read';
  readonly sameDescriptorWithinUnit: true;
  readonly freshReadsEachPass: true;
  readonly mergedUnits: false;
  readonly bodyCache: false;
  readonly transientAncestorChanges: 'may-be-unobserved-within-unit';
  readonly continuousPathIdentity: false;
  readonly atomicSnapshot: false;
}
export interface CompanyGitRangeUnitProfile extends Omit<CompanyGitRangeProfile, 'policy'> {
  readonly policy: typeof COMPANY_GIT_RANGE_UNIT_POLICY;
  readonly guardPolicy: CompanyGitRangeUnitGuardPolicy;
  readonly guardPolicyHash: string;
}
/** Existing numeric accounting is bound to reader-v2 and its distinct observation contract. */
export interface CompanyGitRangeUnitBudgetSnapshot extends CompanyGitRangeBudgetSnapshot {
  readonly guardPolicyHash: string;
}
export interface CompanyGitRangeUnitFailure extends Omit<CompanyGitRangeFailure, 'version'> {
  readonly version: 'company-git-range-failure-v2';
  readonly guardPolicyHash: string;
}
