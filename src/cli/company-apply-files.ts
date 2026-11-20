import fs, { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { companyDirectoryChain, companyPath } from './company-readonly-files.js';

const fail = (code = 'UNSAFE_RUNTIME'): never => { throw new HarnessError(`COMPANY_APPLY_${code}`); };
const controlName = 'company-apply-control.sqlite';
const sameIdentity = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
  && a.gid === b.gid && a.mode === b.mode;
const sameFile = (a: Stats, b: Stats): boolean => sameIdentity(a, b) && a.nlink === b.nlink && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export const companyApplyPath = (value: unknown): string => {
  try { return companyPath(value); } catch { return fail('UNSAFE_PATH'); }
};
const privateDirectory = async (path: string): Promise<Stats> => {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o7777) !== 0o700 || await realpath(path) !== path) fail();
  return metadata;
};
const privateFile = (metadata: Stats, maximum: number): void => {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1
    || (metadata.mode & 0o7777) !== 0o600 || metadata.size > maximum) fail();
};
const names = async (path: string): Promise<string[]> => {
  const result: string[] = [];
  for await (const entry of await opendir(path)) {
    if (result.length >= 5) fail();
    result.push(entry.name);
  }
  return result;
};
const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
};

/** No filename or environment discovery: only the explicitly supplied private JSON is opened. */
export const readCompanyApplyPrivateJson = async (requested: string, kind: 'registration' | 'draft'):
Promise<{ value: unknown; guard: () => Promise<void> }> => {
  try {
    const path = companyApplyPath(requested), maximum = kind === 'registration' ? 16_384 : 262_144;
    const parentGuard = await companyDirectoryChain(dirname(path)); await privateDirectory(dirname(path));
    const before = await lstat(path); privateFile(before, maximum);
    if (await realpath(path) !== path) fail();
    const guard = async (): Promise<void> => {
      await parentGuard(); await privateDirectory(dirname(path));
      const after = await lstat(path); privateFile(after, maximum);
      if (!sameFile(before, after) || await realpath(path) !== path) fail('INPUT_CHANGED');
    };
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      if (!sameFile(before, await handle.stat())) fail();
      const bytes = Buffer.alloc(maximum + 1); let length = 0;
      while (length < bytes.length) {
        const part = await handle.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (length !== before.size || length > maximum || !sameFile(before, await handle.stat())) fail();
      await guard(); text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    } finally { await handle.close(); }
    return { value: parseReadonlyTransportJson(text, maximum), guard };
  } catch { return fail('INVALID_PRIVATE_FILE'); }
};

/** Initialization is restricted to plan. Other commands cannot create a missing or repair a foreign runtime. */
export const prepareCompanyApplyRuntime = async (requested: string, create: boolean): Promise<() => Promise<void>> => {
  try {
    const runtime = companyApplyPath(requested), parentGuard = await companyDirectoryChain(dirname(runtime));
    await privateDirectory(dirname(runtime));
    let existing = true;
    try { await lstat(runtime); } catch (error) {
      if (!create || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') fail();
      existing = false; await mkdir(runtime, { mode: 0o700 });
    }
    const before = await privateDirectory(runtime), entries = await names(runtime);
    const allowed = ['tasks', ...['', '-journal', '-wal', '-shm'].map(suffix => controlName + suffix)];
    if (entries.some(name => !allowed.includes(name))) fail();
    if (entries.length === 0 && create) { await mkdir(join(runtime, 'tasks'), { mode: 0o700 }); await syncDirectory(runtime); }
    const taskDirectory = await privateDirectory(join(runtime, 'tasks'));
    if (!create && !entries.includes(controlName)) fail();
    for (const name of entries.filter(name => name !== 'tasks')) {
      privateFile(await lstat(join(runtime, name)), 65_536);
      if (await realpath(join(runtime, name)) !== join(runtime, name)) fail();
    }
    if (!existing) await syncDirectory(dirname(runtime));
    const guard = async (): Promise<void> => {
      await parentGuard(); await privateDirectory(dirname(runtime));
      if (!sameIdentity(before, await privateDirectory(runtime)) || !sameIdentity(taskDirectory, await privateDirectory(join(runtime, 'tasks')))) fail();
      if ((await names(runtime)).some(name => !allowed.includes(name))) fail();
    };
    await guard(); return guard;
  } catch (error) { if (error instanceof HarnessError && error.code.startsWith('COMPANY_APPLY_')) throw error; return fail(); }
};

const controlSchema = `CREATE TABLE company_apply_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), location_hash TEXT NOT NULL, owner_id TEXT NOT NULL, binding_hash TEXT NOT NULL
) STRICT`;
const controlOptions: DatabaseSyncOptions = { allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false,
  timeout: 100, limits: { length: 65_536, sqlLength: 16_384, attach: 0 } };
const normalizeSql = (sql: string): string => sql.replace(/\s+/gu, ' ').trim();
const controlError = (error: unknown): HarnessError => {
  if (error instanceof HarnessError && error.code.startsWith('COMPANY_APPLY_')) return error;
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'errcode')?.value : undefined;
  return new HarnessError(`COMPANY_APPLY_${typeof code === 'number' && [5, 6].includes(code & 0xff) ? 'CONTROL_BUSY' : 'UNSAFE_CONTROL'}`);
};

/** Keep the returned closure alive until command finally. SQLite owns the lease and releases it on process death. */
export const acquireCompanyApplyControl = (requested: string, create = false): (() => void) => {
  let database: DatabaseSync | undefined;
  try {
    const runtime = companyApplyPath(requested), path = join(runtime, controlName), uid = process.getuid?.();
    if (uid === undefined) fail('UNSAFE_CONTROL');
    const parents: { path: string; metadata: Stats }[] = [];
    for (let current = runtime; ; current = dirname(current)) {
      const metadata = fs.lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.realpathSync(current) !== current
        || current === runtime && (metadata.uid !== uid || (metadata.mode & 0o7777) !== 0o700)) fail('UNSAFE_CONTROL');
      parents.push({ path: current, metadata }); if (current === dirname(current)) break;
    }
    let fileIdentity: Stats | null = null;
    const sidecars = new Map<string, Stats>();
    const metadata = (file: string): Stats | null => {
      try { const value = fs.lstatSync(file); privateFile(value, 65_536); return value; }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
    };
    const protect = (required: boolean): void => {
      for (const parent of parents) if (!sameIdentity(parent.metadata, fs.lstatSync(parent.path)) || fs.realpathSync(parent.path) !== parent.path) fail('UNSAFE_CONTROL');
      const directory = fs.opendirSync(runtime);
      try {
        let count = 0;
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++count > 5 || entry.name !== 'tasks' && !['', '-journal', '-wal', '-shm'].some(suffix => entry!.name === controlName + suffix)) fail('UNSAFE_CONTROL');
        }
      } finally { directory.closeSync(); }
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        const current = metadata(path + suffix);
        if (!suffix) {
          if (required && !current || current && fileIdentity && !sameIdentity(fileIdentity, current)) fail('UNSAFE_CONTROL');
        } else {
          const previous = sidecars.get(suffix);
          if (previous && current && !sameIdentity(previous, current)) fail('UNSAFE_CONTROL');
          if (current) sidecars.set(suffix, current); else sidecars.delete(suffix);
        }
      }
    };
    const location = hashReadonlyValue(path), owner = `os-user:${uid}`;
    const binding = hashReadonlyValue(canonicalReadonlyJson(['company-apply-control-v1', location, owner]));
    const validate = (db: DatabaseSync): void => {
      if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x43415034
        || db.prepare('PRAGMA user_version').get()?.user_version !== 1
        || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete'
        || db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) fail('INVALID_CONTROL');
      const objects = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all();
      if (objects.length !== 1 || objects[0]!.type !== 'table' || objects[0]!.name !== 'company_apply_control'
        || objects[0]!.tbl_name !== 'company_apply_control' || typeof objects[0]!.sql !== 'string'
        || normalizeSql(objects[0]!.sql) !== normalizeSql(controlSchema)) fail('INVALID_CONTROL');
      const rows = db.prepare('SELECT singleton, location_hash, owner_id, binding_hash FROM company_apply_control LIMIT 2').all();
      if (rows.length !== 1 || rows[0]!.singleton !== 1 || rows[0]!.location_hash !== location
        || rows[0]!.owner_id !== owner || rows[0]!.binding_hash !== binding) fail('INVALID_CONTROL');
    };
    protect(false); const existing = metadata(path);
    if (existing) {
      fileIdentity = existing; const readonly = new DatabaseSync(path, { ...controlOptions, readOnly: true });
      try { validate(readonly); } finally { readonly.close(); }
    } else {
      if (!create) fail('CONTROL_NOT_INITIALIZED');
      if (['-journal', '-wal', '-shm'].some(suffix => metadata(path + suffix))) fail('UNSAFE_CONTROL');
      fs.closeSync(fs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      fileIdentity = fs.lstatSync(path);
    }
    protect(true); database = new DatabaseSync(path, controlOptions);
    database.exec('PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF');
    if (existing) validate(database);
    else {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(`PRAGMA application_id = ${0x43415034}; PRAGMA user_version = 1; ${controlSchema};`);
        database.prepare('INSERT INTO company_apply_control VALUES (1, ?, ?, ?)').run(location, owner, binding);
        protect(true); database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    }
    database.exec('BEGIN EXCLUSIVE'); protect(true); validate(database);
    const held = database; let released = false;
    return () => {
      if (released) return;
      try { held.close(); released = true; protect(true); } catch (error) { throw controlError(error); }
    };
  } catch (error) { try { database?.close(); } catch { /* Preserve the first fixed failure. */ } throw controlError(error); }
};
