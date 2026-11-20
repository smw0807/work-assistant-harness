import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CompanyChangePlan, CompanyChangeSnapshot } from '../domain/company-change.js';
import { HarnessError } from '../domain/errors.js';
import { getCompanyChangeLimits, hashCompanyChangeValue } from '../policy/company-change.js';
import { canonicalReadonlyJson, isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { companyPath } from './company-readonly-files.js';

const fail = (): never => { throw new HarnessError('COMPANY_CHANGE_UNSAFE_RUNTIME'); };
export const COMPANY_CHANGE_MAX_REVIEW_FILES = 256;
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
const identity = (value: Stats) => ({ dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode,
  nlink: value.nlink, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs });
type FileIdentity = ReturnType<typeof identity>;
const ownedIdentity = (value: Stats) => ({ dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode, nlink: value.nlink });
type OwnedIdentity = ReturnType<typeof ownedIdentity>;
const sameOwnedFile = (left: OwnedIdentity, right: Stats): boolean => canonicalReadonlyJson(left) === canonicalReadonlyJson(ownedIdentity(right));
const sameFile = (left: FileIdentity, right: Stats): boolean => canonicalReadonlyJson(left) === canonicalReadonlyJson(identity(right));
export const companyChangeFileExists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
};
export const assertCompanyChangeDirectory = async (path: string): Promise<Stats> => {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o7777) !== 0o700 || await realpath(path) !== path) fail();
  return metadata;
};
export const assertCompanyChangeFile = async (path: string, maximum: number): Promise<Stats> => {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.uid !== process.getuid?.()
    || (value.mode & 0o7777) !== 0o600 || value.size > maximum || await realpath(path) !== path) fail();
  return value;
};
const names = async (path: string, maximum: number): Promise<string[]> => {
  const result: string[] = [];
  for await (const item of await opendir(path)) {
    if (result.length >= maximum) fail();
    result.push(item.name);
  }
  return result;
};

/** Ancestor identity is checked by the parent; the worker only reads its explicitly granted paths. */
export const validateCompanyChangeRuntime = async (runtime: string): Promise<() => Promise<void>> => {
  companyPath(runtime);
  const directories = [runtime, join(runtime, 'store'), join(runtime, 'reviews')];
  const observations = await Promise.all(directories.map(assertCompanyChangeDirectory));
  if ((await names(runtime, 2)).sort().join() !== 'reviews,store') fail();
  for (const name of await names(join(runtime, 'store'), 8)) {
    if (!['company-change.sqlite', 'company-change.sqlite-journal', 'company-change.sqlite-wal', 'company-change.sqlite-shm',
      'company-change-lease.sqlite', 'company-change-lease.sqlite-journal', 'company-change-lease.sqlite-wal', 'company-change-lease.sqlite-shm'].includes(name)) fail();
    await assertCompanyChangeFile(join(runtime, 'store', name), Number.MAX_SAFE_INTEGER);
  }
  for (const name of await names(join(runtime, 'reviews'), COMPANY_CHANGE_MAX_REVIEW_FILES)) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?:\.meta)?\.json$/u.test(name)) fail();
    await assertCompanyChangeFile(join(runtime, 'reviews', name), name.endsWith('.meta.json') ? 4096 : getCompanyChangeLimits().maxReviewJsonBytes);
  }
  return async () => {
    for (const [index, path] of directories.entries()) if (!sameIdentity(observations[index]!, await assertCompanyChangeDirectory(path))) fail();
  };
};

export const prepareCompanyChangeRuntime = async (runtime: string, create: boolean): Promise<void> => {
  companyPath(runtime);
  await assertCompanyChangeDirectory(dirname(runtime));
  if (!await companyChangeFileExists(runtime)) {
    if (!create) fail();
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(join(runtime, 'store'), { mode: 0o700 });
    await mkdir(join(runtime, 'reviews'), { mode: 0o700 });
  }
  const guard = await validateCompanyChangeRuntime(runtime); await guard();
};

/** No other file, environment variable, source path or credential location is discovered. */
const readPrivateText = async (path: string, maximum: number): Promise<string> => {
  companyPath(path);
  const before = await assertCompanyChangeFile(path, maximum), descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(identity(before), await descriptor.stat())) fail();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await descriptor.read(bytes, length, bytes.length - length, length);
      if (part.bytesRead === 0) break;
      length += part.bytesRead;
    }
    if (length > maximum || length !== before.size || !sameFile(identity(before), await descriptor.stat())
      || !sameFile(identity(before), await assertCompanyChangeFile(path, maximum))) fail();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally { await descriptor.close(); }
};
export const readCompanyChangePrivateJson = async (path: string, maximum: number): Promise<unknown> =>
  parseReadonlyTransportJson(await readPrivateText(path, maximum), maximum);

interface ReviewManifest {
  version: 'company-change-review-file-v1';
  taskId: string;
  planHash: string;
  ownerId: string;
  expiresAt: string;
  bodyHash: string;
  bodyBytes: number;
  file: OwnedIdentity;
  manifestHash: string;
}
const reviewPaths = (runtime: string, id: string) => {
  if (!isReadonlyId(id)) fail();
  return { body: join(runtime, 'reviews', `${id}.json`), manifest: join(runtime, 'reviews', `${id}.meta.json`) };
};
const readManifest = async (path: string, id: string): Promise<ReviewManifest> => {
  const value = await readCompanyChangePrivateJson(path, 4096) as ReviewManifest;
  if (!readonlyExactKeys(value, ['version', 'taskId', 'planHash', 'ownerId', 'expiresAt', 'bodyHash', 'bodyBytes', 'file', 'manifestHash'])
    || value.version !== 'company-change-review-file-v1' || value.taskId !== id || value.ownerId !== `os-user:${process.getuid?.()}`
    || !/^[a-f0-9]{64}$/u.test(value.planHash) || !/^[a-f0-9]{64}$/u.test(value.bodyHash)
    || !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString() !== value.expiresAt
    || !readonlyExactKeys(value.file, ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'])
    || Object.values(value.file).some(field => typeof field !== 'number' || !Number.isFinite(field) || field < 0)
    || value.file.uid !== process.getuid?.() || value.file.nlink !== 1 || (value.file.mode & 0o7777) !== 0o600
    || !Number.isSafeInteger(value.bodyBytes) || value.bodyBytes < 1 || value.bodyBytes > getCompanyChangeLimits().maxReviewJsonBytes) fail();
  const { manifestHash, ...content } = value;
  if (manifestHash !== hashCompanyChangeValue(canonicalReadonlyJson(content))) fail();
  return value;
};
const assertManifestPlan = (manifest: ReviewManifest, plan: CompanyChangePlan | undefined): void => {
  if (plan && (manifest.taskId !== plan.id || manifest.ownerId !== plan.ownerId || manifest.planHash !== plan.planHash
    || manifest.expiresAt !== plan.expiresAt)) fail();
};
const verifyLiveReviewBody = async (path: string, manifest: ReviewManifest, now: Date): Promise<void> => {
  if (now.getTime() >= Date.parse(manifest.expiresAt)) throw new HarnessError('COMPANY_CHANGE_REVIEW_EXPIRED');
  const file = await assertCompanyChangeFile(path, getCompanyChangeLimits().maxReviewJsonBytes);
  if (!sameOwnedFile(manifest.file, file) || file.size !== manifest.bodyBytes) fail();
  const body = await readPrivateText(path, getCompanyChangeLimits().maxReviewJsonBytes);
  if (hashCompanyChangeValue(body) !== manifest.bodyHash) fail();
};

const writeExclusive = async (path: string, body: string): Promise<Stats> => {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    const metadata = await handle.stat();
    if (!sameFile(identity(metadata), await assertCompanyChangeFile(path, Buffer.byteLength(body)))) fail();
    return metadata;
  } finally { await handle.close(); }
};

/** Review copies are regenerable, not approval records; no fsync durability is claimed for them. */
export const writeCompanyChangeReview = async (runtime: string, snapshot: CompanyChangeSnapshot, clock = (): Date => new Date()): Promise<void> => {
  if (!snapshot.draft || !['AWAITING_APPROVAL', 'APPROVED'].includes(snapshot.status)) throw new HarnessError('COMPANY_CHANGE_REVIEW_UNAVAILABLE');
  const live = (): void => {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getTime() < Date.parse(snapshot.plan.createdAt)
      || now.getTime() >= Date.parse(snapshot.plan.expiresAt)) throw new HarnessError('COMPANY_CHANGE_REVIEW_EXPIRED');
  };
  live();
  const guard = await validateCompanyChangeRuntime(runtime), paths = reviewPaths(runtime, snapshot.plan.id);
  const review = { version: 'company-change-local-review-v1', plan: snapshot.plan, draft: snapshot.draft,
    changes: snapshot.draft.changes.map(change => ({ path: change.path, operation: change.operation, beforeHash: change.beforeHash,
      afterHash: hashCompanyChangeValue(change.content) })),
    sourceVerification: 'not_run', approvalScope: 'review-only', executionAllowed: false, transmissionAllowed: false, productChecks: 'not_run' };
  const body = `${canonicalReadonlyJson(review)}\n`, bodyHash = hashCompanyChangeValue(body);
  if (Buffer.byteLength(body) > getCompanyChangeLimits().maxReviewJsonBytes) throw new HarnessError('COMPANY_CHANGE_REVIEW_LIMIT');
  if (await companyChangeFileExists(paths.manifest)) {
    const existing = await readManifest(paths.manifest, snapshot.plan.id);
    if (existing.planHash !== snapshot.plan.planHash || existing.expiresAt !== snapshot.plan.expiresAt || existing.bodyHash !== bodyHash
      || existing.bodyBytes !== Buffer.byteLength(body)) fail();
    await verifyLiveReviewBody(paths.body, existing, clock());
    await guard(); live(); return;
  }
  if (await companyChangeFileExists(paths.body)) fail();
  if ((await names(join(runtime, 'reviews'), COMPANY_CHANGE_MAX_REVIEW_FILES)).length + 2 > COMPANY_CHANGE_MAX_REVIEW_FILES) {
    throw new HarnessError('COMPANY_CHANGE_REVIEW_CAPACITY');
  }
  live();
  const handle = await open(paths.body, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const file = await handle.stat();
  let manifestCreated = false;
  try {
    const content: Omit<ReviewManifest, 'manifestHash'> = { version: 'company-change-review-file-v1', taskId: snapshot.plan.id,
      ownerId: snapshot.plan.ownerId, planHash: snapshot.plan.planHash, expiresAt: snapshot.plan.expiresAt, bodyHash,
      bodyBytes: Buffer.byteLength(body), file: ownedIdentity(file) };
    const manifest: ReviewManifest = { ...content, manifestHash: hashCompanyChangeValue(canonicalReadonlyJson(content)) };
    live();
    await writeExclusive(paths.manifest, `${canonicalReadonlyJson(manifest)}\n`);
    manifestCreated = true;
    live();
    await handle.writeFile(body, 'utf8');
    if (!sameOwnedFile(manifest.file, await handle.stat())) fail();
    await verifyLiveReviewBody(paths.body, manifest, clock());
    await guard(); live();
  } catch (error) {
    // Only the exact file created above is eligible for cleanup; foreign replacements remain untouched.
    try {
      await guard();
      if (manifestCreated) await removeCompanyChangeReview(runtime, snapshot.plan.id, snapshot.plan);
      else if (!await companyChangeFileExists(paths.manifest) && await companyChangeFileExists(paths.body)
        && sameOwnedFile(ownedIdentity(file), await assertCompanyChangeFile(paths.body, getCompanyChangeLimits().maxReviewJsonBytes))) await unlink(paths.body);
    } catch { /* Preserve uncertain artifacts and the original failure instead of guessing ownership. */ }
    throw error;
  } finally { await handle.close(); }
};

/** Expired bodies are never opened or hashed. The retained metadata identifies only the managed copy. */
export const removeCompanyChangeReview = async (runtime: string, id: string, plan?: CompanyChangePlan): Promise<number> => {
  const guard = await validateCompanyChangeRuntime(runtime), paths = reviewPaths(runtime, id);
  if (!await companyChangeFileExists(paths.manifest)) {
    if (await companyChangeFileExists(paths.body)) fail();
    return 0;
  }
  const manifestBefore = await assertCompanyChangeFile(paths.manifest, 4096), manifest = await readManifest(paths.manifest, id);
  assertManifestPlan(manifest, plan);
  if (await companyChangeFileExists(paths.body)) {
    if (!sameOwnedFile(manifest.file, await assertCompanyChangeFile(paths.body, getCompanyChangeLimits().maxReviewJsonBytes))) fail();
    await guard(); await unlink(paths.body);
  }
  if (!sameFile(identity(manifestBefore), await assertCompanyChangeFile(paths.manifest, 4096))) fail();
  await unlink(paths.manifest); await guard(); return 1;
};
export const pruneCompanyChangeReviews = async (runtime: string, now: Date): Promise<number> => {
  let removed = 0;
  const guard = await validateCompanyChangeRuntime(runtime);
  const entries = await names(join(runtime, 'reviews'), COMPANY_CHANGE_MAX_REVIEW_FILES), available = new Set(entries);
  // An empty orphan can precede the retention intent; never describe that uncertain artifact as cleaned.
  if (entries.some(name => !name.endsWith('.meta.json') && !available.has(`${name.slice(0, -5)}.meta.json`))) {
    throw new HarnessError('COMPANY_CHANGE_REVIEW_ORPHAN');
  }
  for (const name of entries) {
    if (!name.endsWith('.meta.json')) continue;
    const id = name.slice(0, -10), value = await readManifest(join(runtime, 'reviews', name), id);
    if (now.getTime() >= Date.parse(value.expiresAt)) removed += await removeCompanyChangeReview(runtime, id);
  }
  await guard(); return removed;
};
export const companyChangeReviewExists = async (runtime: string, id: string, plan?: CompanyChangePlan): Promise<boolean> => {
  const paths = reviewPaths(runtime, id);
  if (!await companyChangeFileExists(paths.manifest)) return false;
  const manifest = await readManifest(paths.manifest, id);
  assertManifestPlan(manifest, plan);
  await verifyLiveReviewBody(paths.body, manifest, new Date());
  return true;
};

/** The SQLite lease serializes CLI review publication and cancellation, and releases on process death. */
export const acquireCompanyChangeLease = async (runtime: string): Promise<() => Promise<void>> => {
  const path = join(runtime, 'store', 'company-change-lease.sqlite'), guard = await validateCompanyChangeRuntime(runtime);
  const location = hashCompanyChangeValue(path), owner = `os-user:${process.getuid?.()}`;
  const schema = 'CREATE TABLE company_change_lease (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), location_hash TEXT NOT NULL, owner_id TEXT NOT NULL) STRICT';
  const options = { allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false, timeout: 100 };
  const rethrow = (error: unknown): never => {
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'errcode')?.value : null;
    if (typeof code === 'number' && [5, 6].includes(code & 0xff)) throw new HarnessError('COMPANY_CHANGE_BUSY');
    throw error;
  };
  const validate = (database: DatabaseSync): void => {
    const objects = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const binding = objects.length === 1 && objects[0]!.type === 'table' && objects[0]!.name === 'company_change_lease'
      && objects[0]!.sql === schema ? database.prepare('SELECT * FROM company_change_lease').all() : [];
    if (database.prepare('PRAGMA application_id').get()!.application_id !== 0x43434c31
      || database.prepare('PRAGMA user_version').get()!.user_version !== 1 || binding.length !== 1
      || binding[0]!.singleton !== 1 || binding[0]!.location_hash !== location || binding[0]!.owner_id !== owner) fail();
  };
  const existing = await companyChangeFileExists(path);
  if (existing) {
    await assertCompanyChangeFile(path, 65_536);
    const readonly = new DatabaseSync(path, { ...options, readOnly: true });
    try { validate(readonly); } catch (error) { rethrow(error); } finally { readonly.close(); }
  } else {
    for (const suffix of ['-journal', '-wal', '-shm']) if (await companyChangeFileExists(`${path}${suffix}`)) fail();
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  }
  const before = await assertCompanyChangeFile(path, 65_536), database = new DatabaseSync(path, options);
  try {
    if (!existing) {
      database.exec(`BEGIN IMMEDIATE; PRAGMA application_id = 1128483889; PRAGMA user_version = 1; ${schema};`);
      database.prepare('INSERT INTO company_change_lease VALUES (1, ?, ?)').run(location, owner);
      database.exec('COMMIT');
    }
    validate(database);
    database.exec('BEGIN EXCLUSIVE');
    if (!sameIdentity(before, await assertCompanyChangeFile(path, 65_536))) fail();
    await guard();
    return async () => {
      database.close();
      if (!sameIdentity(before, await assertCompanyChangeFile(path, 65_536))) fail();
      await guard();
    };
  } catch (error) {
    database.close();
    return rethrow(error);
  }
};
