import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { applyClaimedCompanyApply } from '../application/apply-company-apply.js';
import { getCompanyApplyLimits, parseCompanyApplyRegistration } from '../policy/company-apply.js';
import { parseCompanyChangeDraft } from '../policy/company-change.js';
import { readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { HarnessError } from '../domain/errors.js';

const limits = getCompanyApplyLimits();
let started = false, finished = false, size = 0;
const chunks: Buffer[] = [];
const stop = (): never => process.exit(1);
const timer = setTimeout(stop, limits.workerWallTimeMs);
// EOF is an additional stop signal; an already-issued filesystem mutation is preserved as uncertain.
process.stdin.on('end', () => { if (!finished) stop(); });
process.stdin.on('error', stop);
process.on('SIGTERM', stop);
const run = async (text: string): Promise<void> => {
  const input: unknown = JSON.parse(text);
  if (readonlyExactKeys(input, ['version', 'canary'])) {
    const probe = input as Record<string, unknown>;
    if (probe.version !== 'company-apply-probe-v1' || typeof probe.canary !== 'string' || !isAbsolute(probe.canary)
      || resolve(probe.canary) !== probe.canary) throw new HarnessError('COMPANY_APPLY_INVALID_WORKER_INPUT');
    const denied = (operation: () => void): void => {
      try { operation(); } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) return;
        throw new HarnessError('COMPANY_APPLY_ISOLATION_FAILED');
      }
      throw new HarnessError('COMPANY_APPLY_ISOLATION_FAILED');
    };
    const canary = probe.canary;
    denied(() => { fs.readFileSync(canary); });
    denied(() => { fs.writeFileSync(canary, 'synthetic isolation violation'); });
    for (const executable of ['/usr/bin/true', process.execPath]) {
      const result = spawnSync(executable, [], { env: {} });
      if (!result.error || !('code' in result.error) || !['EACCES', 'EPERM'].includes(String(result.error.code))) {
        throw new HarnessError('COMPANY_APPLY_ISOLATION_FAILED');
      }
    }
    await new Promise<void>((resolveProbe, reject) => {
      const socket = connect({ host: '127.0.0.1', port: 9 });
      socket.setTimeout(1000);
      socket.on('connect', () => { socket.destroy(); reject(new HarnessError('COMPANY_APPLY_ISOLATION_FAILED')); });
      socket.on('timeout', () => { socket.destroy(); reject(new HarnessError('COMPANY_APPLY_ISOLATION_FAILED')); });
      socket.on('error', error => {
        if ('code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) resolveProbe();
        else reject(new HarnessError('COMPANY_APPLY_ISOLATION_FAILED'));
      });
    });
    finished = true; clearTimeout(timer);
    process.stdout.write('{"isolationVerified":true}\n', () => process.exit(0));
    return;
  }
  if (!readonlyExactKeys(input, ['version', 'registration', 'draft', 'journalDirectory'])) throw new HarnessError('COMPANY_APPLY_INVALID_WORKER_INPUT');
  const value = input as Record<string, unknown>;
  if (value.version !== 'company-apply-worker-v1' || typeof value.journalDirectory !== 'string'
    || !isAbsolute(value.journalDirectory) || resolve(value.journalDirectory) !== value.journalDirectory
    || dirname(value.journalDirectory) === value.journalDirectory) throw new HarnessError('COMPANY_APPLY_INVALID_WORKER_INPUT');
  const registration = parseCompanyApplyRegistration(value.registration), draft = parseCompanyChangeDraft(value.draft);
  const result = await applyClaimedCompanyApply(registration, draft, value.journalDirectory);
  finished = true; clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({ status: result.status, taskId: result.taskId, planHash: result.planHash,
    approvalConsumed: true, journalEntries: result.journal.length, osIsolation: true, scope: 'company-local-write' })}\n`,
  () => process.exit(result.status === 'APPLIED' ? 0 : 1));
};
process.stdin.on('data', (chunk: Buffer) => {
  if (started) { stop(); }
  size += chunk.length; if (size > limits.maxWorkerInputBytes + 1) stop();
  chunks.push(chunk);
  const newline = chunk.indexOf(10);
  if (newline < 0) return;
  if (newline !== chunk.length - 1) stop();
  started = true;
  const bytes = Buffer.concat(chunks).subarray(0, -1), text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) stop();
  void run(text).catch(() => {
    finished = true; clearTimeout(timer); process.stderr.write('COMPANY_APPLY_WORKER_FAILED\n', () => process.exit(1));
  });
});
