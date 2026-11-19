import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { getCompanyGitRangeUnitProfile } from '../policy/company-git-range-unit-budget.js';
import { getDefaultReadonlyRelayExecutionBudget } from '../policy/readonly-relay-budget-policy.js';
import { parseCompanyRelaySummary, type CompanyRelayCommand, type CompanyRelaySummary } from './company-relay-protocol.js';
import type { CompanyV3SupervisorClock } from './company-readonly-v3-supervisor.js';

const clock: CompanyV3SupervisorClock = {
  now: () => performance.now(), schedule: (callback, milliseconds) => setTimeout(callback, milliseconds), cancel: timer => clearTimeout(timer),
};
export interface CompanyRelayOutcome {
  summary: CompanyRelaySummary | null;
  reason: 'completed' | 'deadline' | 'output_limit' | 'worker_failed' | 'invalid_output' | 'cleanup_uncertain';
  exitConfirmed: boolean;
}
/** No body or stderr text escapes the child. A successful reply also requires confirmed close. */
export const superviseCompanyRelayWorker = (child: ChildProcessWithoutNullStreams, command: CompanyRelayCommand,
  id: string | null, startedAtMs: number, time: CompanyV3SupervisorClock = clock): Promise<CompanyRelayOutcome> => new Promise(resolve => {
  const profile = getCompanyGitRangeUnitProfile().limits;
  const deadlineMs = command === 'run' ? getDefaultReadonlyRelayExecutionBudget().totalTimeoutMs : profile.wallClockMs;
  let reason: CompanyRelayOutcome['reason'] | null = null, output = Buffer.alloc(0), stderrBytes = 0;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const terminate = (cause: CompanyRelayOutcome['reason']): void => {
    if (reason !== null) return;
    reason = cause; child.kill('SIGTERM');
    grace = time.schedule(() => { child.kill('SIGKILL'); }, command === 'run'
      ? Math.max(0, Math.min(getDefaultReadonlyRelayExecutionBudget().cleanupTimeoutMs, deadlineMs - (time.now() - startedAtMs))) : profile.terminationGraceMs);
  };
  const terminationAtMs = command === 'run' ? deadlineMs - getDefaultReadonlyRelayExecutionBudget().cleanupTimeoutMs : deadlineMs;
  const deadline = time.schedule(() => terminate('deadline'), Math.max(0, terminationAtMs - (time.now() - startedAtMs)));
  child.stdout.on('data', (chunk: Buffer) => {
    if (reason !== null) return;
    if (output.length + chunk.length > 65_536) { terminate('output_limit'); return; }
    output = Buffer.concat([output, chunk]);
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16_384) terminate('output_limit'); });
  child.stdout.on('error', () => terminate('worker_failed')); child.stderr.on('error', () => terminate('worker_failed'));
  child.on('error', () => terminate('worker_failed'));
  child.once('close', (code, signal) => {
    time.cancel(deadline); if (grace !== undefined) time.cancel(grace);
    if (reason === null && time.now() - startedAtMs >= deadlineMs) reason = 'deadline';
    if (reason !== null || code !== 0 || signal !== null) {
      resolve({ summary: null, reason: reason ?? 'worker_failed', exitConfirmed: true }); return;
    }
    try {
      const summary = parseCompanyRelaySummary(new TextDecoder('utf-8', { fatal: true }).decode(output), command, id);
      resolve({ summary, reason: 'completed', exitConfirmed: true });
    } catch { resolve({ summary: null, reason: 'invalid_output', exitConfirmed: true }); }
  });
});
