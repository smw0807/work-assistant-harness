import type { CompanyGitRangeBudget } from '../policy/company-git-range-budget.js';

/** Pure codecs share reservation operations, never a reader profile or filesystem authority. */
export type CompanyGitRangeBudgetOperations = Pick<CompanyGitRangeBudget, keyof CompanyGitRangeBudget>;
