import type { CompanyGitRangeBudgetSnapshot, CompanyGitRangePhase, CompanyGitRangeProfile } from './company-git-range.js';
import type { PersonalCollectionProfile } from './personal-readonly-collection.js';

export const COMPANY_GIT_RANGE_DIAGNOSTIC_STAGES = Object.freeze([
  'budget', 'head', 'pack_inventory', 'pack_index', 'pack_header', 'git_object', 'commit', 'tree',
  'selected_file', 'safe_view', 'working_index', 'final_guard', 'cleanup',
] as const);
export type CompanyGitRangeDiagnosticStage = typeof COMPANY_GIT_RANGE_DIAGNOSTIC_STAGES[number];
export type CompanyGitRangeLimitName = keyof CompanyGitRangeProfile['limits'] | keyof PersonalCollectionProfile['limits']
  | 'inflationOutputBytes';
export const COMPANY_GIT_RANGE_LIMIT_NAMES = Object.freeze([
  'packBytes', 'indexBytes', 'indexObjects', 'indexBytesPerPass', 'indexObjectsPerPass',
  'gitFileBytes', 'workingIndexObjects', 'packDirectoryEntries', 'candidatePairs',
  'readChunkBytes', 'encodedObjectBytes', 'objectBytes', 'looseHeaderBytes',
  'dependencyNodes', 'visitedObjects', 'inflations', 'inflatedBytes',
  'readBytesPerPass', 'readBytes', 'readCalls', 'metadataCalls', 'openDescriptors',
  'managedBytes', 'cacheBytes', 'oldSpaceMiB', 'rssTargetBytes', 'wallClockMs', 'terminationGraceMs',
  'sourceFileBytes', 'fullViewBytes', 'excerptBytes', 'evidenceBytes', 'inputBytes', 'files', 'ranges', 'linesPerRange', 'masks',
  'inflationOutputBytes',
] as const satisfies readonly CompanyGitRangeLimitName[]);

export interface CompanyGitRangeFailureLimit {
  readonly name: CompanyGitRangeLimitName;
  readonly current: number;
  readonly requested: number;
  readonly maximum: number;
}
export type CompanyGitRangeFailureCounters = Omit<CompanyGitRangeBudgetSnapshot, 'profileHash' | 'phase' | 'failureCode'>;

/** A local diagnostic of the first enforced limit, without paths, object identities, source text or error stacks. */
export interface CompanyGitRangeFailure {
  readonly version: 'company-git-range-failure-v1';
  readonly profileHash: string;
  readonly errorCode: 'COMPANY_GIT_RANGE_LIMIT' | 'COMPANY_GIT_RANGE_TIMEOUT';
  readonly phase: Exclude<CompanyGitRangePhase, 'failed'>;
  readonly stage: CompanyGitRangeDiagnosticStage;
  readonly limit: CompanyGitRangeFailureLimit;
  readonly counters: CompanyGitRangeFailureCounters;
}
