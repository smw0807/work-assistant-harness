import { COMPANY_GIT_RANGE_DIAGNOSTIC_STAGES, COMPANY_GIT_RANGE_LIMIT_NAMES,
  type CompanyGitRangeFailure } from '../domain/company-git-range-diagnostic.js';
import { HarnessError } from '../domain/errors.js';
import { getCompanyGitRangeProfile, getCompanyGitRangeProfileHash } from './company-git-range-budget.js';
import { copyCompanyReadonlyV2Data } from './company-readonly-v2.js';
import { getPersonalCollectionProfile } from './personal-readonly-collection.js';

export const COMPANY_GIT_RANGE_DIAGNOSTIC_BYTES = 8192;
const reject = (): never => { throw new HarnessError('COMPANY_READONLY_V2_INVALID_DIAGNOSTIC'); };
const exact = (value: unknown, names: readonly string[]): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key)));
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const counterNames = ['startedAtMs', 'lastNowMs', 'completedPasses', 'readBytesReserved', 'readBytesReturned', 'readCalls', 'pendingReads',
  'metadataCalls', 'inflations', 'pendingInflations', 'outputBytesCharged', 'inflationBytesActual', 'reconstructionBytes', 'visitedObjects',
  'dependencyDepth', 'peakDependencyDepth', 'liveMemoryBytes', 'peakMemoryBytes', 'cacheMemoryBytes', 'peakCacheMemoryBytes',
  'openDescriptors', 'peakOpenDescriptors', 'passes'];

/** Validate only fixed categories and bounded numeric observations. No private source/error fields are accepted. */
export const parseCompanyGitRangeFailure = (input: unknown): CompanyGitRangeFailure => {
  try {
    const value = copyCompanyReadonlyV2Data(input) as CompanyGitRangeFailure;
    const limits = getCompanyGitRangeProfile().limits;
    const maxima = { ...limits, ...getPersonalCollectionProfile().limits, inflationOutputBytes: limits.objectBytes + limits.looseHeaderBytes };
    if (Buffer.byteLength(JSON.stringify(value)) > COMPANY_GIT_RANGE_DIAGNOSTIC_BYTES
      || !exact(value, ['version', 'profileHash', 'errorCode', 'phase', 'stage', 'limit', 'counters'])
      || value.version !== 'company-git-range-failure-v1' || value.profileHash !== getCompanyGitRangeProfileHash()
      || !['COMPANY_GIT_RANGE_LIMIT', 'COMPANY_GIT_RANGE_TIMEOUT'].includes(value.errorCode)
      || !['ready', 'inspect', 'between', 'verify', 'complete'].includes(value.phase)
      || !COMPANY_GIT_RANGE_DIAGNOSTIC_STAGES.includes(value.stage)
      || !exact(value.limit, ['name', 'current', 'requested', 'maximum']) || !COMPANY_GIT_RANGE_LIMIT_NAMES.includes(value.limit.name)
      || value.limit.maximum !== maxima[value.limit.name] || !integer(value.limit.requested)) reject();
    if (value.errorCode === 'COMPANY_GIT_RANGE_TIMEOUT') {
      if (value.limit.name !== 'wallClockMs' || !time(value.limit.current) || value.limit.requested !== 0 || value.limit.current < limits.wallClockMs) reject();
    } else if (!integer(value.limit.current) || value.limit.name === 'wallClockMs'
      || value.limit.current <= value.limit.maximum - value.limit.requested) reject();
    const counters = value.counters;
    if (!exact(counters, counterNames) || !time(counters.startedAtMs) || !time(counters.lastNowMs)
      || counters.startedAtMs > Number.MAX_SAFE_INTEGER - limits.wallClockMs
      || counters.lastNowMs < counters.startedAtMs || !exact(counters.passes, ['inspect', 'verify'])) reject();
    for (const name of counterNames.filter(name => !['startedAtMs', 'lastNowMs', 'passes'].includes(name))) {
      if (!integer(counters[name as keyof typeof counters])) reject();
    }
    const caps = { readBytesReserved: limits.readBytes, readBytesReturned: limits.readBytes, readCalls: limits.readCalls,
      metadataCalls: limits.metadataCalls, inflations: limits.inflations, outputBytesCharged: limits.inflatedBytes,
      inflationBytesActual: limits.inflatedBytes, reconstructionBytes: limits.inflatedBytes, visitedObjects: limits.visitedObjects,
      dependencyDepth: limits.dependencyNodes, peakDependencyDepth: limits.dependencyNodes, liveMemoryBytes: limits.managedBytes,
      peakMemoryBytes: limits.managedBytes, cacheMemoryBytes: limits.cacheBytes, peakCacheMemoryBytes: limits.cacheBytes,
      openDescriptors: limits.openDescriptors, peakOpenDescriptors: limits.openDescriptors };
    for (const [name, maximum] of Object.entries(caps)) if (!integer(counters[name as keyof typeof caps], maximum)) reject();
    for (const pass of [counters.passes.inspect, counters.passes.verify]) {
      if (!exact(pass, ['readBytesReserved', 'indexBytes', 'indexObjects', 'indexes']) || !integer(pass.readBytesReserved, limits.readBytesPerPass)
        || !integer(pass.indexBytes, limits.indexBytesPerPass) || !integer(pass.indexObjects, limits.indexObjectsPerPass)
        || !integer(pass.indexes, limits.candidatePairs)) reject();
    }
    const passes = { ready: 0, inspect: 0, between: 1, verify: 1, complete: 2 };
    const elapsed = counters.lastNowMs - counters.startedAtMs;
    if (value.errorCode === 'COMPANY_GIT_RANGE_TIMEOUT' ? value.limit.current !== elapsed : elapsed >= limits.wallClockMs) reject();
    if (counters.completedPasses !== passes[value.phase] || counters.readBytesReturned > counters.readBytesReserved
      || counters.readBytesReserved !== counters.passes.inspect.readBytesReserved + counters.passes.verify.readBytesReserved
      || counters.pendingReads > counters.readCalls || counters.pendingInflations > counters.inflations
      || counters.readBytesReserved > counters.readCalls * limits.readChunkBytes
      || counters.inflationBytesActual > counters.inflations * (limits.objectBytes + limits.looseHeaderBytes)
      || counters.inflationBytesActual + counters.reconstructionBytes > counters.outputBytesCharged
      || counters.dependencyDepth > counters.peakDependencyDepth || counters.liveMemoryBytes > counters.peakMemoryBytes
      || counters.peakDependencyDepth > counters.visitedObjects
      || counters.cacheMemoryBytes > counters.liveMemoryBytes || counters.cacheMemoryBytes > counters.peakCacheMemoryBytes
      || counters.peakCacheMemoryBytes > counters.peakMemoryBytes || counters.openDescriptors > counters.peakOpenDescriptors) reject();
    if (['ready', 'inspect', 'between'].includes(value.phase) && Object.values(counters.passes.verify).some(count => count !== 0)) reject();
    if (['ready', 'between', 'complete'].includes(value.phase)
      && (counters.pendingReads || counters.pendingInflations || counters.openDescriptors || counters.dependencyDepth)) reject();
    if (['between', 'complete'].includes(value.phase) && counters.cacheMemoryBytes) reject();
    if (value.phase === 'ready' && (counters.readCalls || counters.metadataCalls || counters.inflations || counters.outputBytesCharged
      || counters.visitedObjects || counters.peakOpenDescriptors || Object.values(counters.passes.inspect).some(count => count !== 0))) reject();
    for (const pass of [counters.passes.inspect, counters.passes.verify]) {
      if (!pass.indexes && (pass.indexBytes || pass.indexObjects)) reject();
    }
    return value;
  } catch { return reject(); }
};
