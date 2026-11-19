import { constants } from 'node:fs';
import { lstat, open, opendir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readonlyRelayCleanupConfirmed } from '../adapters/readonly-relay-lifecycle.js';
import type { CompanyRelayPlan } from '../domain/company-relay.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { assertCompanyRelayPlan } from '../policy/company-relay.js';
import { canonicalReadonlyJson, hashReadonlyValue, isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { assertCompanyRelayDirectory, assertCompanyRelayPrivateFile, readCompanyRelayPrivateJson } from './company-relay-files.js';
import { companyDirectoryChain } from './company-readonly-files.js';

interface RetentionRecord {
  version: 'company-relay-artifacts-v1'; investigationId: string; planHash: string; auditExpiresAt: string;
  requestBodyHash: string; requestEnvelopeHash: string; connectionProfileHash: string; recordHash: string;
}
export interface CompanyRelayArtifactPruneResult { removedRuns: number; removedManifests: number; preservedUncertain: number }
type Metadata = Awaited<ReturnType<typeof lstat>>;
const keys = ['version', 'investigationId', 'planHash', 'auditExpiresAt', 'requestBodyHash', 'requestEnvelopeHash', 'connectionProfileHash', 'recordHash'];
const reject = (): never => { throw new HarnessError('COMPANY_RELAY_UNSAFE_ARTIFACTS'); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const metadata = async (path: string): Promise<Metadata | null> => {
  try { return await lstat(path); } catch (error) { if (absent(error)) return null; throw error; }
};
const same = (left: Metadata, right: Metadata): boolean => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
  .every(key => left[key as keyof Metadata] === right[key as keyof Metadata]);
const readRetention = async (path: string): Promise<RetentionRecord> => {
  const value = await readCompanyRelayPrivateJson(path, 4096) as RetentionRecord;
  if (!readonlyExactKeys(value, keys) || value.version !== 'company-relay-artifacts-v1' || !isReadonlyId(value.investigationId)
    || ![value.planHash, value.requestBodyHash, value.requestEnvelopeHash, value.connectionProfileHash, value.recordHash].every(hash)
    || typeof value.auditExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.auditExpiresAt))
    || new Date(value.auditExpiresAt).toISOString() !== value.auditExpiresAt) reject();
  const { recordHash, ...fields } = value;
  if (recordHash !== hashReadonlyValue(canonicalReadonlyJson(fields))) reject();
  return value;
};
const removeFile = async (path: string, expected: Metadata, guard: () => Promise<void>): Promise<void> => {
  await guard(); await assertCompanyRelayPrivateFile(path, 16_384);
  if (!same(expected, await lstat(path))) reject();
  await unlink(path); await guard();
};
const assertIsolationCanary = async (path: string): Promise<void> => {
  const expected = Buffer.from('synthetic isolation canary');
  await assertCompanyRelayPrivateFile(path, expected.length);
  const before = await lstat(path), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(before, await handle.stat())) reject();
    const bytes = Buffer.alloc(expected.length + 1), result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== expected.length || !bytes.subarray(0, result.bytesRead).equals(expected)
      || !same(before, await handle.stat()) || !same(before, await lstat(path))) reject();
  } finally { await handle.close(); }
};

/** Written before native lifecycle creation; a retry cannot extend the inherited audit deadline. */
export const registerCompanyRelayArtifacts = async (runtime: string, plan: CompanyRelayPlan): Promise<void> => {
  assertCompanyRelayPlan(plan);
  if (plan.ownerId !== `os-user:${process.getuid?.()}`) reject();
  const directory = join(runtime, 'readonly-relay-runs'), guard = await companyDirectoryChain(directory);
  await assertCompanyRelayDirectory(directory);
  const path = join(directory, `${plan.id}.retention.json`);
  const fields: Omit<RetentionRecord, 'recordHash'> = { version: 'company-relay-artifacts-v1', investigationId: plan.id, planHash: plan.planHash,
    auditExpiresAt: plan.auditExpiresAt, requestBodyHash: plan.requestBodyHash, requestEnvelopeHash: plan.requestEnvelopeHash,
    connectionProfileHash: plan.connectionProfileHash };
  const record = { ...fields, recordHash: hashReadonlyValue(canonicalReadonlyJson(fields)) };
  if (await metadata(path)) {
    const prior = await readRetention(path);
    if (keys.some(key => prior[key as keyof RetentionRecord] !== record[key as keyof RetentionRecord])) reject();
  } else {
    await guard(); await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600, flush: true });
    await assertCompanyRelayPrivateFile(path, 4096);
  }
  await guard();
};

const closedMetadata = async (runtime: string, record: RetentionRecord): Promise<{ files: { path: string; metadata: Metadata }[]; guard: () => Promise<void> } | null> => {
  const directory = join(runtime, 'readonly-relay-runs', record.investigationId);
  await assertCompanyRelayDirectory(directory);
  const guard = await companyDirectoryChain(directory);
  try {
    const entries: string[] = [];
    for await (const entry of await opendir(directory)) {
      if (entries.length >= 4) return null;
      entries.push(entry.name);
    }
    if (!entries.includes('lifecycle.json') || !entries.includes('child.json')
      || entries.some(name => !['lifecycle.json', 'child.json', 'call-report.json', 'host-canary.txt'].includes(name))) return null;
    const files: { path: string; metadata: Metadata }[] = [];
    for (const name of entries) {
      const path = join(directory, name); await assertCompanyRelayPrivateFile(path, 16_384); files.push({ path, metadata: await lstat(path) });
    }
    if (entries.includes('host-canary.txt')) await assertIsolationCanary(join(directory, 'host-canary.txt'));
    const lifecycle = await readCompanyRelayPrivateJson(join(directory, 'lifecycle.json'), 4096) as Record<string, unknown>;
    if (lifecycle.state !== 'closed' || lifecycle.investigationId !== record.investigationId
      || ['requestBodyHash', 'requestEnvelopeHash', 'connectionProfileHash'].some(key => lifecycle[key] !== record[key as keyof RetentionRecord])) return null;
    if (entries.includes('call-report.json')) {
      const report = await readCompanyRelayPrivateJson(join(directory, 'call-report.json'), 16_384) as Record<string, unknown>;
      if (report.policy !== 'company-relay-plan-v1' || report.cleanupConfirmed !== true
        || ['requestBodyHash', 'requestEnvelopeHash', 'connectionProfileHash'].some(key => report[key] !== record[key as keyof RetentionRecord])) return null;
    }
    const hashes = { requestBodyHash: record.requestBodyHash, requestEnvelopeHash: record.requestEnvelopeHash, connectionProfileHash: record.connectionProfileHash };
    if (!readonlyRelayCleanupConfirmed(runtime, record.investigationId, hashes)) return null;
    for (const file of files) {
      await assertCompanyRelayPrivateFile(file.path, 16_384);
      if (!same(file.metadata, await lstat(file.path))) return null;
    }
    await guard(); return { files, guard };
  } catch { return null; }
};

/** Uncertain or unexpected directories are retained for operator handling, never recursively removed. */
export const pruneCompanyRelayArtifacts = async (runtime: string, context: ReadonlyContext): Promise<CompanyRelayArtifactPruneResult> => {
  if (context.ownerId !== `os-user:${process.getuid?.()}` || !(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) reject();
  const directory = join(runtime, 'readonly-relay-runs'), guard = await companyDirectoryChain(directory);
  await assertCompanyRelayDirectory(directory);
  const result: CompanyRelayArtifactPruneResult = { removedRuns: 0, removedManifests: 0, preservedUncertain: 0 };
  const names = new Set<string>(); let count = 0;
  for await (const entry of await opendir(directory)) {
    if (++count > 4096) reject();
    const id = entry.name.replace(/\.retention\.json$/u, '');
    if (!isReadonlyId(id) || entry.name !== id && entry.name !== `${id}.retention.json`) reject();
    names.add(entry.name);
  }
  for (const name of names) {
    if (!name.endsWith('.retention.json')) {
      if (!names.has(`${name}.retention.json`)) result.preservedUncertain++;
      continue;
    }
    const path = join(directory, name), before = await lstat(path);
    let record: RetentionRecord;
    try { record = await readRetention(path); }
    catch (error) {
      // A controller killed during the immutable write may leave a partial manifest. Its deadline is unknown.
      if (error instanceof HarnessError && error.code === 'READONLY_TRANSPORT_INVALID_RESPONSE') { result.preservedUncertain++; continue; }
      throw error;
    }
    if (name !== `${record.investigationId}.retention.json`) reject();
    if (record.auditExpiresAt > context.now.toISOString()) continue;
    const run = join(directory, record.investigationId), runMetadata = await metadata(run);
    if (runMetadata) {
      const closed = await closedMetadata(runtime, record);
      if (!closed) { result.preservedUncertain++; continue; }
      await guard(); await closed.guard();
      for (const file of closed.files) await removeFile(file.path, file.metadata, closed.guard);
      await closed.guard(); await rmdir(run); await guard(); result.removedRuns++;
    }
    await removeFile(path, before, guard); result.removedManifests++;
  }
  await guard(); return result;
};
