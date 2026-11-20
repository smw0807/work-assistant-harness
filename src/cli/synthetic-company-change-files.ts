import { constants, type Stats } from 'node:fs';
import { mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import { canonicalReadonlyJson, isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { companyDirectoryChain, companyPathsOverlap } from './company-readonly-files.js';
import { assertCompanyChangeDirectory, assertCompanyChangeFile, companyChangeFileExists,
  readCompanyChangePrivateJson } from './company-change-files.js';

const fail = (): never => { throw new HarnessError('SYNTHETIC_COMPANY_CHANGE_UNSAFE_RUNTIME'); };
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
const within = (root: string, value: string): boolean => value !== root && value.startsWith(`${root}${sep}`);
export const syntheticChangePath = async (value: unknown): Promise<string> => {
  if (typeof value !== 'string' || value.length > 4096 || resolve(value) !== value || value.includes('\0')
    || value.includes('\\') || value.split('/').some(part => part.startsWith('.git') || /^\.(?:env|ssh|aws|codex)(?:\.|$)/u.test(part))) return fail();
  const roots = [...new Set(await Promise.all([tmpdir(), '/private/tmp'].map(path => realpath(path))))];
  if (!roots.some(root => within(root, value))) return fail();
  return value;
};
const names = async (path: string, maximum: number): Promise<string[]> => {
  const result: string[] = [];
  for await (const item of await opendir(path)) {
    if (result.length >= maximum) fail(); result.push(item.name);
  }
  return result;
};
export const prepareSyntheticChangeRuntime = async (runtime: string, create: boolean): Promise<void> => {
  await syntheticChangePath(runtime); await assertCompanyChangeDirectory(dirname(runtime));
  const present = await companyChangeFileExists(runtime);
  if (create ? present : !present) fail();
  if (create) await mkdir(runtime, { mode: 0o700 });
  await assertCompanyChangeDirectory(runtime);
};
export const validateSyntheticChangeRuntime = async (runtime: string, initializing = false): Promise<() => Promise<void>> => {
  await syntheticChangePath(runtime);
  const guard = await companyDirectoryChain(runtime), root = await assertCompanyChangeDirectory(runtime);
  const entries = await names(runtime, 7);
  if (initializing ? entries.length !== 0 : !['store', 'control', 'reports', 'synthetic-workspace.json'].every(name => entries.includes(name))) fail();
  if (!initializing) {
    const workspaces = entries.filter(name => /^company-change-synthetic-[A-Za-z0-9]{6}$/u.test(name));
    if (workspaces.length !== 1 || entries.some(name => !['store', 'control', 'reports', 'synthetic-workspace.json', 'example-draft.json', ...workspaces].includes(name))) fail();
    for (const directory of ['store', 'control', 'reports', ...workspaces]) await assertCompanyChangeDirectory(join(runtime, directory));
    await assertCompanyChangeFile(join(runtime, 'synthetic-workspace.json'), 131_072);
    if (entries.includes('example-draft.json')) await assertCompanyChangeFile(join(runtime, 'example-draft.json'), 262_144);
    const stores = await names(join(runtime, 'store'), 4);
    if (!stores.includes('synthetic-company-change.sqlite') || stores.some(name => !/^synthetic-company-change\.sqlite(?:-journal|-wal|-shm)?$/u.test(name))) fail();
    for (const name of stores) await assertCompanyChangeFile(join(runtime, 'store', name), Number.MAX_SAFE_INTEGER);
    for (const name of await names(join(runtime, 'reports'), 256)) {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/u.test(name)
        && !/^\.synthetic-change-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/u.test(name)) fail();
      await assertCompanyChangeFile(join(runtime, 'reports', name), 65_536);
    }
  }
  return async () => { await guard(); if (!sameIdentity(root, await assertCompanyChangeDirectory(runtime))) fail(); };
};
export const validateSyntheticChangeDraftPath = async (runtime: string, path: string): Promise<() => Promise<void>> => {
  await syntheticChangePath(path);
  if (companyPathsOverlap(runtime, path) && path !== join(runtime, 'example-draft.json')) fail();
  const guard = await companyDirectoryChain(dirname(path));
  await assertCompanyChangeDirectory(dirname(path)); await assertCompanyChangeFile(path, 262_144);
  return guard;
};
export const readSyntheticChangeDraft = (path: string): Promise<unknown> => readCompanyChangePrivateJson(path, 262_144);

export const writeSyntheticChangeJson = async (path: string, value: unknown, replace = false): Promise<void> => {
  const body = `${canonicalReadonlyJson(value)}\n`;
  if (Buffer.byteLength(body) > (replace ? 65_536 : 262_144)) fail();
  const parent = dirname(path), parentMetadata = await assertCompanyChangeDirectory(parent);
  const previous = await companyChangeFileExists(path) ? await assertCompanyChangeFile(path, 65_536) : null;
  if (previous && !replace) fail();
  const temporary = replace ? join(parent, `.synthetic-change-${randomUUID()}.tmp`) : path;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const identity = await file.stat();
  try {
    await file.writeFile(body, 'utf8'); await file.sync();
    if (!sameIdentity(identity, await assertCompanyChangeFile(temporary, Buffer.byteLength(body)))) fail();
    if (replace) {
      if (previous ? !sameIdentity(previous, await assertCompanyChangeFile(path, 65_536)) : await companyChangeFileExists(path)) fail();
      if (!sameIdentity(parentMetadata, await assertCompanyChangeDirectory(parent))) fail();
      await rename(temporary, path);
    }
    const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try {
      if (replace && await companyChangeFileExists(temporary)) {
        if (!sameIdentity(identity, await assertCompanyChangeFile(temporary, 65_536))) fail();
        await unlink(temporary);
      }
    } finally { await file.close(); }
  }
};
export const writeSyntheticChangeReport = async (runtime: string, taskId: string, value: unknown): Promise<void> => {
  if (!isReadonlyId(taskId)) fail();
  const path = join(runtime, 'reports', `${taskId}.json`);
  // Publication needs one temporary slot even when replacing an existing report.
  if ((await names(join(runtime, 'reports'), 256)).length >= 256) fail();
  await writeSyntheticChangeJson(path, value, true);
};
