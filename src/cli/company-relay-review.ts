import { lstat, opendir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompanyRelaySnapshot, CompanyRelayStore } from '../domain/company-relay.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { assertCompanyRelayDirectory, assertCompanyRelayPrivateFile, readCompanyRelayPrivateJson } from './company-relay-files.js';
import { companyDirectoryChain } from './company-readonly-files.js';

const reject = (): never => { throw new HarnessError('COMPANY_RELAY_UNSAFE_REVIEW'); };
const keys = ['version', 'taskId', 'planHash', 'expiresAt', 'plan', 'requestEnvelope', 'report'];
const reviewName = (id: string): string => { if (!isReadonlyId(id)) reject(); return `${id}.json`; };
const removeReview = async (path: string, expected: Awaited<ReturnType<typeof lstat>>): Promise<void> => {
  const parents = await companyDirectoryChain(join(path, '..'));
  await assertCompanyRelayPrivateFile(path, 2_097_152);
  const now = await lstat(path);
  if (now.dev !== expected.dev || now.ino !== expected.ino || now.size !== expected.size || now.mtimeMs !== expected.mtimeMs) reject();
  await parents(); await unlink(path); await parents();
};
/** Managed copies follow the original payload TTL; cleanup runs on commands, not in a background daemon. */
export const pruneCompanyRelayReviews = async (runtime: string, store: CompanyRelayStore, context: ReadonlyContext): Promise<void> => {
  const directory = join(runtime, 'reviews'); await assertCompanyRelayDirectory(directory);
  for await (const entry of await opendir(directory)) {
    const id = entry.name.replace(/\.json$/, '');
    if (entry.name !== reviewName(id)) reject();
    const path = join(directory, entry.name), before = await lstat(path);
    const input = await readCompanyRelayPrivateJson(path, 2_097_152);
    if (!readonlyExactKeys(input, keys)) reject();
    const value = input as Record<string, unknown>;
    if (value.version !== 'company-relay-review-v1' || value.taskId !== id || typeof value.planHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.planHash) || typeof value.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString() !== value.expiresAt) reject();
    let snapshot: CompanyRelaySnapshot | null;
    try { snapshot = store.inspect(id, context); }
    catch (error) { if (!(error instanceof HarnessError) || error.code !== 'COMPANY_RELAY_NOT_FOUND') throw error; snapshot = null; }
    if (snapshot && (value.planHash !== snapshot.plan.planHash || value.expiresAt !== snapshot.plan.expiresAt)) reject();
    if (!snapshot?.payload || (value.expiresAt as string) <= context.now.toISOString()) await removeReview(path, before);
  }
};
export const writeCompanyRelayReview = async (runtime: string, store: CompanyRelayStore, id: string, context: ReadonlyContext,
  clock: () => Date = () => new Date()): Promise<void> => {
  await pruneCompanyRelayReviews(runtime, store, context);
  const snapshot = store.inspect(id, context);
  if (!snapshot.payload || !['AWAITING_APPROVAL', 'APPROVED', 'REPORTED'].includes(snapshot.status)) reject();
  const payload = snapshot.payload!;
  const path = join(runtime, 'reviews', reviewName(id));
  const parents = await companyDirectoryChain(join(runtime, 'reviews'));
  try { const before = await lstat(path); await removeReview(path, before); }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
  // Never copy local source root, file identities, credentials or raw relay response bytes.
  const value = { version: 'company-relay-review-v1', taskId: id, planHash: snapshot.plan.planHash,
    expiresAt: snapshot.plan.expiresAt, plan: snapshot.plan, requestEnvelope: payload.requestEnvelope, report: snapshot.report };
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 2_097_152) reject();
  await parents(); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); await parents();
  await pruneCompanyRelayReviews(runtime, store, { ...context, now: clock() });
  await assertCompanyRelayPrivateFile(path, 2_097_152);
};
