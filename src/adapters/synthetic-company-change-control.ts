import { closeSync, constants, lstatSync, openSync, opendirSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import { canonicalReadonlyJson } from '../policy/readonly-investigation-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';
import { getSyntheticCompanyChangeLimits, hashSyntheticCompanyChangeValue } from '../policy/synthetic-company-change.js';

const filename = 'synthetic-company-change-control.sqlite';
const applicationId = 0x53434332;
const table = `CREATE TABLE synthetic_company_change_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), location_hash TEXT NOT NULL, owner_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL
) STRICT`;
const databaseOptions: DatabaseSyncOptions = { allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false,
  timeout: getSyntheticCompanyChangeLimits().busyTimeoutMs, limits: { length: 65_536, sqlLength: 16_384, attach: 0 } };
const fail: (suffix?: string) => never = (suffix = 'UNSAFE_CONTROL') => { throw new HarnessError(`SYNTHETIC_COMPANY_CHANGE_${suffix}`); };
const safeError = (error: unknown): HarnessError => {
  if (error instanceof HarnessError && ['SYNTHETIC_COMPANY_CHANGE_UNSAFE_CONTROL', 'SYNTHETIC_COMPANY_CHANGE_INVALID_CONTROL',
    'SYNTHETIC_COMPANY_CHANGE_CONTROL_NOT_INITIALIZED'].includes(error.code)) return error;
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'errcode')?.value : undefined;
  return new HarnessError(`SYNTHETIC_COMPANY_CHANGE_${typeof code === 'number' && [5, 6].includes(code & 0xff) ? 'CONTROL_BUSY' : 'UNSAFE_CONTROL'}`);
};
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
const normalizedSql = (value: string): string => value.replace(/\s+/gu, ' ').trim();

/**
 * Hold this lease for the entire runtime command, including recovery observation and ledger updates.
 * Retain the returned release function until command cleanup; it owns the live SQLite connection.
 * Only init passes create=true. SQLite releases the lock on process death; no PID is stored or stolen.
 */
export const acquireSyntheticCompanyChangeControl = (runtime: string, create = false): (() => void) => {
  let database: DatabaseSync | undefined;
  try {
    if (typeof runtime !== 'string' || !isAbsolute(runtime) || resolve(runtime) !== runtime || typeof create !== 'boolean') fail();
    const uid = process.getuid?.(); if (uid === undefined) fail();
    const control = join(runtime, 'control'), path = join(control, filename);
    const parents: { path: string; identity: Stats }[] = [];
    for (let current = control; ; current = dirname(current)) {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(current) !== current) fail();
      if ([runtime, control].includes(current) && (metadata.uid !== uid || (metadata.mode & 0o7777) !== 0o700)) fail();
      parents.push({ path: current, identity: metadata }); if (current === dirname(current)) break;
    }
    const sidecars = new Map<string, Stats>(); let fileIdentity: Stats | null = null;
    const protect = (required: boolean): void => {
      for (const parent of parents) {
        const current = lstatSync(parent.path);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parent.identity, current)
          || realpathSync(parent.path) !== parent.path) fail();
      }
      const directory = opendirSync(control);
      try {
        let count = 0;
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++count > 4 || !['', '-journal', '-wal', '-shm'].some(suffix => entry!.name === filename + suffix)) fail();
        }
      } finally { directory.closeSync(); }
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        const file = path + suffix; assertRuntimeFile(file); const metadata = runtimePathMetadata(file);
        if (metadata && (metadata.uid !== uid || (metadata.mode & 0o7777) !== 0o600 || metadata.size > 65_536)) fail();
        if (!suffix) {
          if (required && !metadata || metadata && fileIdentity && !sameIdentity(fileIdentity, metadata)) fail();
        } else {
          const previous = sidecars.get(suffix);
          if (metadata && previous && !sameIdentity(previous, metadata)) fail();
          if (metadata) sidecars.set(suffix, metadata); else sidecars.delete(suffix);
        }
      }
    };
    const location = hashSyntheticCompanyChangeValue(path), owner = `os-user:${uid}`;
    const bindingHash = hashSyntheticCompanyChangeValue(canonicalReadonlyJson(['synthetic-company-change-control-v1', location, owner]));
    const validate = (connection: DatabaseSync): void => {
      if (connection.prepare('PRAGMA application_id').get()?.application_id !== applicationId
        || connection.prepare('PRAGMA user_version').get()?.user_version !== 1
        || connection.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete'
        || connection.prepare('PRAGMA synchronous').get()?.synchronous !== 2) fail('INVALID_CONTROL');
      const schema = connection.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all();
      if (schema.length !== 1 || schema[0]!.type !== 'table' || schema[0]!.name !== 'synthetic_company_change_control'
        || schema[0]!.tbl_name !== 'synthetic_company_change_control' || typeof schema[0]!.sql !== 'string'
        || normalizedSql(schema[0]!.sql) !== normalizedSql(table)) fail('INVALID_CONTROL');
      const binding = connection.prepare('SELECT singleton, location_hash, owner_id, binding_hash FROM synthetic_company_change_control LIMIT 2').all();
      if (binding.length !== 1 || binding[0]!.singleton !== 1 || binding[0]!.location_hash !== location
        || binding[0]!.owner_id !== owner || binding[0]!.binding_hash !== bindingHash) fail('INVALID_CONTROL');
    };
    protect(false);
    const existing = runtimePathMetadata(path);
    if (existing) {
      fileIdentity = existing;
      const readonly = new DatabaseSync(path, { ...databaseOptions, readOnly: true });
      try { validate(readonly); } finally { readonly.close(); }
      protect(true);
    } else {
      if (!create) fail('CONTROL_NOT_INITIALIZED');
      if (['-journal', '-wal', '-shm'].some(suffix => runtimePathMetadata(path + suffix))) fail();
      closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      fileIdentity = lstatSync(path);
    }
    database = new DatabaseSync(path, databaseOptions); protect(true);
    database.exec('PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
    if (existing) validate(database);
    else {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1; ${table};`);
        database.prepare('INSERT INTO synthetic_company_change_control VALUES (1, ?, ?, ?)').run(location, owner, bindingHash);
        protect(true); database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      validate(database);
    }
    database.exec('BEGIN EXCLUSIVE'); protect(true); validate(database);
    const held = database; let released = false;
    return () => {
      if (released) return;
      try { held.close(); released = true; protect(true); }
      catch (error) { throw safeError(error); }
    };
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original fixed failure. */ }
    throw safeError(error);
  }
};
