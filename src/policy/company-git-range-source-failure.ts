import { HarnessError } from '../domain/errors.js';

const reasons = ['head_ref', 'delta_base', 'object_lookup', 'object_type', 'tree_selection',
  'source_size', 'safe_view', 'excerpt', 'unexpected'] as const;
export type CompanyGitRangeSourceFailureReason = typeof reasons[number];
const allowed: ReadonlySet<string> = new Set(reasons);
const failures = new WeakMap<object, CompanyGitRangeSourceFailureReason>();

export const isCompanyGitRangeSourceFailureReason = (value: unknown): value is CompanyGitRangeSourceFailureReason =>
  typeof value === 'string' && allowed.has(value);

/** The diagnostic is attached to an issued error identity, never to arbitrary exception properties or source data. */
export const createCompanyGitRangeSourceFailure = (reason: CompanyGitRangeSourceFailureReason): HarnessError => {
  const error = new HarnessError('COMPANY_GIT_RANGE_INVALID_SOURCE');
  if (isCompanyGitRangeSourceFailureReason(reason)) failures.set(error, reason);
  return error;
};

export const extractCompanyGitRangeSourceFailureReason = (error: unknown): CompanyGitRangeSourceFailureReason | null =>
  typeof error === 'object' && error !== null ? failures.get(error) ?? null : null;
