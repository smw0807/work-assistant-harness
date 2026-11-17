import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { getCompanyGitRangeProfile } from '../policy/company-git-range-budget.js';
import { parseCompanyV2Summary, type CompanyV2Command, type CompanyV2Summary } from './company-readonly-v2-protocol.js';

type Timer = ReturnType<typeof setTimeout>;
export interface CompanyV2SupervisorClock {
  now(): number;
  schedule(callback: () => void, milliseconds: number): Timer;
  cancel(timer: Timer): void;
}
const clock: CompanyV2SupervisorClock = {
  now: () => performance.now(), schedule: (callback, milliseconds) => setTimeout(callback, milliseconds), cancel: timer => clearTimeout(timer),
};
export interface CompanyV2WorkerOutcome {
  summary: CompanyV2Summary | null;
  reason: 'completed' | 'deadline' | 'output_limit' | 'worker_failed' | 'invalid_output';
  exitConfirmed: boolean;
}

/** Only trusted harness code supplies the child and clock; no registration can choose a command or deadline. */
export const superviseCompanyV2Worker = (child: ChildProcessWithoutNullStreams, command: CompanyV2Command, id: string | null,
  startedAtMs: number, time: CompanyV2SupervisorClock = clock): Promise<CompanyV2WorkerOutcome> => new Promise(resolve => {
  const limits = getCompanyGitRangeProfile().limits;
  let reason: CompanyV2WorkerOutcome['reason'] | null = null, output = Buffer.alloc(0), stderrBytes = 0;
  let grace: Timer | undefined;
  const terminate = (cause: CompanyV2WorkerOutcome['reason']): void => {
    if (reason !== null) return;
    reason = cause;
    child.kill('SIGTERM');
    grace = time.schedule(() => { child.kill('SIGKILL'); }, limits.terminationGraceMs);
  };
  const deadline = time.schedule(() => terminate('deadline'), Math.max(0, limits.wallClockMs - (time.now() - startedAtMs)));
  child.stdout.on('data', (chunk: Buffer) => {
    if (reason !== null) return;
    if (output.length + chunk.length > 65_536) { terminate('output_limit'); return; }
    output = Buffer.concat([output, chunk]);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65_536) terminate('output_limit');
  });
  child.stdout.on('error', () => terminate('worker_failed'));
  child.stderr.on('error', () => terminate('worker_failed'));
  child.on('error', () => terminate('worker_failed'));
  child.once('close', (code, signal) => {
    time.cancel(deadline); if (grace !== undefined) time.cancel(grace);
    // A valid reply alone is insufficient: process exit and the original deadline must also be confirmed.
    if (reason === null && time.now() - startedAtMs >= limits.wallClockMs) reason = 'deadline';
    if (reason !== null || code !== 0 || signal !== null) {
      resolve({ summary: null, reason: reason ?? 'worker_failed', exitConfirmed: true }); return;
    }
    try {
      const summary = parseCompanyV2Summary(new TextDecoder('utf-8', { fatal: true }).decode(output), command, id);
      resolve({ summary, reason: 'completed', exitConfirmed: true });
    } catch { resolve({ summary: null, reason: 'invalid_output', exitConfirmed: true }); }
  });
});
