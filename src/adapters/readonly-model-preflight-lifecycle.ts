import { constants, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { HarnessError } from '../domain/errors.js';

export interface ReadonlyModelPreflightHashes { requestBodyHash: string; connectionProfileHash: string; requestEnvelopeHash: string }
export interface ReadonlyModelPreflightLocation { dataDirectory: string; investigationId: string }
interface Lifecycle extends ReadonlyModelPreflightHashes {
  version: 'readonly-model-preflight-process-v1'; mode: 'offline'; transport: 'in-memory-fake'; investigationId: string;
  state: 'intent' | 'spawned' | 'closed'; pid: number | null;
}
const validHashes = (hashes: ReadonlyModelPreflightHashes): boolean => !!hashes
  && Object.keys(hashes).sort().join(',') === 'connectionProfileHash,requestBodyHash,requestEnvelopeHash'
  && Object.values(hashes).every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const assertDirectory = (path: string): void => {
  const value = lstatSync(path);
  if (!isAbsolute(path) || realpathSync(path) !== path || !value.isDirectory() || value.isSymbolicLink()
    || (value.mode & 0o7777) !== 0o700 || value.uid !== process.getuid?.()) throw new Error('unsafe');
};
const location = ({ dataDirectory, investigationId }: ReadonlyModelPreflightLocation, create: boolean): string => {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(investigationId)) throw new Error('unsafe');
  assertDirectory(dataDirectory);
  const parent = join(dataDirectory, 'readonly-model-preflight-runs');
  if (create && !existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  assertDirectory(parent);
  const directory = join(parent, investigationId);
  if (create) mkdirSync(directory, { mode: 0o700 });
  assertDirectory(directory);
  return join(directory, 'lifecycle.json');
};
const assertFile = (path: string) => {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o7777) !== 0o600
    || metadata.uid !== process.getuid?.() || metadata.size > 2048) throw new Error('unsafe');
  return metadata;
};

/** 입력은 기록하지 않는다. intent가 남으면 PID를 추측하지 않고 복구를 차단한다. */
export const createReadonlyModelPreflightLifecycle = (where: ReadonlyModelPreflightLocation, hashes: ReadonlyModelPreflightHashes) => {
  try {
    if (!validHashes(hashes)) throw new Error('unsafe');
    const path = location(where, true);
    const initial: Lifecycle = { version: 'readonly-model-preflight-process-v1', mode: 'offline', transport: 'in-memory-fake', investigationId: where.investigationId,
      ...hashes, state: 'intent', pid: null };
    writeFileSync(path, JSON.stringify(initial), { mode: 0o600, flag: 'wx', flush: true });
    const update = (state: 'spawned' | 'closed', pid: number | null): void => {
      try {
        if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 1)) throw new Error('unsafe');
        location(where, false);
        const before = assertFile(path);
        const descriptor = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(descriptor);
          if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw new Error('unsafe');
          // 부분 기록은 재시작 시 유효 JSON 검증에서 거부한다.
          ftruncateSync(descriptor, 0);
          writeFileSync(descriptor, JSON.stringify({ ...initial, state, pid }));
          fsyncSync(descriptor);
        } finally { closeSync(descriptor); }
      } catch { throw new HarnessError('READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE'); }
    };
    return { spawned: (pid: number) => update('spawned', pid), closed: (pid: number | null) => update('closed', pid) };
  } catch { throw new HarnessError('READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE'); }
};

/** 소유 기록의 close 또는 PID 부재만 정리 증거로 쓴다. 살아 있거나 재사용된 PID는 종료하지 않는다. */
export const readonlyModelPreflightCleanupConfirmed = (dataDirectory: string, investigationId: string, hashes: ReadonlyModelPreflightHashes): boolean => {
  try {
    const path = location({ dataDirectory, investigationId }, false);
    const before = assertFile(path);
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: unknown;
    try {
      const opened = fstatSync(descriptor);
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size > 2048) return false;
      const raw = readFileSync(descriptor, 'utf8');
      value = JSON.parse(raw) as unknown;
      if (JSON.stringify(value) !== raw || fstatSync(descriptor).size !== opened.size) return false;
    } finally { closeSync(descriptor); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Lifecycle;
    if (Object.keys(record).sort().join(',') !== 'connectionProfileHash,investigationId,mode,pid,requestBodyHash,requestEnvelopeHash,state,transport,version'
      || record.version !== 'readonly-model-preflight-process-v1' || record.mode !== 'offline' || record.transport !== 'in-memory-fake'
      || record.investigationId !== investigationId || record.requestBodyHash !== hashes.requestBodyHash
      || record.connectionProfileHash !== hashes.connectionProfileHash || record.requestEnvelopeHash !== hashes.requestEnvelopeHash
      || !validHashes(hashes)
      || !['intent', 'spawned', 'closed'].includes(record.state)
      || (record.pid !== null && (!Number.isSafeInteger(record.pid) || record.pid <= 1))) return false;
    if (record.state === 'closed') return true;
    if (record.state !== 'spawned' || record.pid === null) return false;
    try { process.kill(record.pid, 0); return false; }
    catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
  } catch { return false; }
};
