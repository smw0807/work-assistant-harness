import { dirname, isAbsolute, resolve } from 'node:path';
import { applyClaimedCompanyWrite } from '../application/apply-company-write.js';
import { getCompanyWriteLimits, parseCompanyWriteRegistration } from '../policy/company-write.js';
import { parseCompanyChangeDraft } from '../policy/company-change.js';
import { readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { HarnessError } from '../domain/errors.js';

const limits = getCompanyWriteLimits();
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
  if (!readonlyExactKeys(input, ['version', 'registration', 'draft', 'journalDirectory'])) throw new HarnessError('COMPANY_WRITE_INVALID_WORKER_INPUT');
  const value = input as Record<string, unknown>;
  if (value.version !== 'company-write-worker-v1' || typeof value.journalDirectory !== 'string'
    || !isAbsolute(value.journalDirectory) || resolve(value.journalDirectory) !== value.journalDirectory
    || dirname(value.journalDirectory) === value.journalDirectory) throw new HarnessError('COMPANY_WRITE_INVALID_WORKER_INPUT');
  const registration = parseCompanyWriteRegistration(value.registration), draft = parseCompanyChangeDraft(value.draft);
  const result = await applyClaimedCompanyWrite(registration, draft, value.journalDirectory);
  finished = true; clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({ status: result.status, taskId: result.taskId, planHash: result.planHash,
    approvalConsumed: true, journalEntries: result.journal.length, osIsolation: true, scope: 'synthetic-validation' })}\n`,
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
    finished = true; clearTimeout(timer); process.stderr.write('COMPANY_WRITE_WORKER_FAILED\n', () => process.exit(1));
  });
});
