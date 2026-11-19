import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { CompanyRelayAuthorization } from '../domain/company-relay.js';
import { HarnessError } from '../domain/errors.js';
import { parseCompanyRelayAuthorization } from '../policy/company-relay.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { companyDirectoryChain, companyPath } from './company-readonly-files.js';
import { companyV3FileExists } from './company-readonly-v3-files.js';

const reject = (): never => { throw new HarnessError('COMPANY_RELAY_UNSAFE_DIRECTORY'); };
export const assertCompanyRelayDirectory = async (path: string): Promise<void> => {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid?.()
    || (value.mode & 0o7777) !== 0o700 || await realpath(path) !== path) reject();
};
export const assertCompanyRelayPrivateFile = async (path: string, limit: number): Promise<void> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o7777) !== 0o600 || metadata.size > limit || await realpath(path) !== path) reject();
};
export const readCompanyRelayPrivateJson = async (path: string, limit: number): Promise<unknown> => {
  companyPath(path);
  const parents = await companyDirectoryChain(dirname(path));
  await assertCompanyRelayDirectory(dirname(path)); await assertCompanyRelayPrivateFile(path, limit);
  const before = await lstat(path), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const same = (value: Awaited<ReturnType<typeof lstat>>) => ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => value[key as keyof typeof value] === before[key as keyof typeof before]);
  try {
    if (!same(await handle.stat())) reject();
    const bytes = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== before.size || bytesRead > limit || !same(await handle.stat()) || !same(await lstat(path))) reject();
    await parents();
    return parseReadonlyTransportJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead)), limit);
  } finally { await handle.close(); }
};
export const readCompanyRelayAuthorization = async (path: string): Promise<CompanyRelayAuthorization> => {
  if (basename(path) !== 'company-relay-authorization.json') throw new HarnessError('COMPANY_RELAY_INVALID_AUTHORIZATION_FILE');
  return parseCompanyRelayAuthorization(await readCompanyRelayPrivateJson(path, 16_384));
};
/** Each runtime owns its database, managed review copies and relay lifecycle directory. */
export const prepareCompanyRelayDirectory = async (path: string, create: boolean): Promise<void> => {
  companyPath(path);
  const parentGuard = await companyDirectoryChain(dirname(path));
  await assertCompanyRelayDirectory(dirname(path));
  if (!await companyV3FileExists(path)) { if (!create) reject(); await mkdir(path, { mode: 0o700 }); }
  await assertCompanyRelayDirectory(path);
  const guard = await companyDirectoryChain(path), entries = await readdir(path);
  if (entries.some(name => !['store', 'reviews', 'readonly-relay-runs'].includes(name))) reject();
  for (const name of ['store', 'reviews', 'readonly-relay-runs']) {
    const directory = join(path, name);
    if (!await companyV3FileExists(directory)) { if (!create) reject(); await mkdir(directory, { mode: 0o700 }); }
    await assertCompanyRelayDirectory(directory);
  }
  for (const name of await readdir(join(path, 'store'))) {
    if (!['company-relay.sqlite', 'company-relay.sqlite-journal', 'company-relay.sqlite-wal', 'company-relay.sqlite-shm'].includes(name)) reject();
    await assertCompanyRelayPrivateFile(join(path, 'store', name), Number.MAX_SAFE_INTEGER);
  }
  await guard(); await parentGuard();
};
