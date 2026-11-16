export const COMPANY_GIT_RANGE_POLICY = 'company-git-range-reader-v1' as const;
export type CompanyGitRangePass = 'inspect' | 'verify';
export type CompanyGitRangePhase = 'ready' | CompanyGitRangePass | 'between' | 'complete' | 'failed';
export type CompanyGitRangeMemoryKind = 'buffer' | 'cache';
export type CompanyGitRangeMetadataOperation = 'lstat' | 'fstat' | 'open' | 'realpath' | 'readdir';

export interface CompanyGitRangeProfile {
  readonly policy: typeof COMPANY_GIT_RANGE_POLICY;
  readonly integrityScope: 'selected-object-chain';
  readonly packChecksum: 'not_checked';
  readonly unvisitedObjects: 'not_checked';
  readonly collectionProfileHash: string;
  readonly contentPasses: readonly ['inspect', 'verify'];
  readonly memoryAccounting: 'managed-backing-buffers-only';
  readonly clock: 'caller-supplied-monotonic-milliseconds';
  readonly limits: Readonly<{
    packBytes: number; indexBytes: number; indexObjects: number; indexBytesPerPass: number; indexObjectsPerPass: number;
    gitFileBytes: number; workingIndexObjects: number; packDirectoryEntries: number; candidatePairs: number;
    readChunkBytes: number; encodedObjectBytes: number; objectBytes: number; looseHeaderBytes: number;
    dependencyNodes: number; visitedObjects: number; inflations: number; inflatedBytes: number;
    readBytesPerPass: number; readBytes: number; readCalls: number; metadataCalls: number; openDescriptors: number;
    managedBytes: number; cacheBytes: number; oldSpaceMiB: number; rssTargetBytes: number;
    wallClockMs: number; terminationGraceMs: number;
  }>;
}

declare const companyGitRangeHandle: unique symbol;
/** Tokens are owned by one budget instance; copying or reconstructing their shape grants no authority. */
export type CompanyGitRangeMemoryLease = Readonly<{ [companyGitRangeHandle]: 'memory' }>;
export type CompanyGitRangeReadReceipt = Readonly<{ [companyGitRangeHandle]: 'read' }>;
export type CompanyGitRangeInflationReceipt = Readonly<{ [companyGitRangeHandle]: 'inflation' }>;
export type CompanyGitRangeDescriptorLease = Readonly<{ [companyGitRangeHandle]: 'descriptor' }>;
export type CompanyGitRangeDependencyLease = Readonly<{ [companyGitRangeHandle]: 'dependency' }>;

export interface CompanyGitRangePassSnapshot {
  readonly readBytesReserved: number;
  readonly indexBytes: number;
  readonly indexObjects: number;
  readonly indexes: number;
}
/** Logical accounting only; it neither measures nor enforces operating-system RSS or elapsed time. */
export interface CompanyGitRangeBudgetSnapshot {
  readonly profileHash: string;
  readonly phase: CompanyGitRangePhase;
  readonly failureCode: string | null;
  readonly startedAtMs: number;
  readonly lastNowMs: number;
  readonly completedPasses: number;
  readonly readBytesReserved: number;
  readonly readBytesReturned: number;
  readonly readCalls: number;
  readonly pendingReads: number;
  readonly metadataCalls: number;
  readonly inflations: number;
  readonly pendingInflations: number;
  readonly outputBytesCharged: number;
  readonly inflationBytesActual: number;
  readonly reconstructionBytes: number;
  readonly visitedObjects: number;
  readonly dependencyDepth: number;
  readonly peakDependencyDepth: number;
  readonly liveMemoryBytes: number;
  readonly peakMemoryBytes: number;
  readonly cacheMemoryBytes: number;
  readonly peakCacheMemoryBytes: number;
  readonly openDescriptors: number;
  readonly peakOpenDescriptors: number;
  readonly passes: Readonly<Record<CompanyGitRangePass, CompanyGitRangePassSnapshot>>;
}
