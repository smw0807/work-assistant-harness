import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { CompanyGitRangeUnitFailure } from '../domain/company-git-range-unit.js';
import type { CompanyGitRangeSourceFailureReason } from '../policy/company-git-range-source-failure.js';
import { getCompanyGitRangeUnitProfile } from '../policy/company-git-range-unit-budget.js';
import { parseCompanyV3Diagnostic } from './company-readonly-v3-diagnostic-protocol.js';
import { parseCompanyV3Summary, type CompanyV3Command, type CompanyV3Summary } from './company-readonly-v3-protocol.js';
import { parseCompanyV3WorkerFailureDetails, type CompanyV3WorkerFailureCode } from './company-readonly-v3-worker-failure.js';

type Timer = ReturnType<typeof setTimeout>;
export interface CompanyV3SupervisorClock {
  now(): number;
  schedule(callback: () => void, milliseconds: number): Timer;
  cancel(timer: Timer): void;
}
const clock: CompanyV3SupervisorClock = {
  now: () => performance.now(), schedule: (callback, milliseconds) => setTimeout(callback, milliseconds), cancel: timer => clearTimeout(timer),
};
export interface CompanyV3WorkerOutcome {
  summary: CompanyV3Summary | null;
  reason: 'completed' | 'deadline' | 'output_limit' | 'worker_failed' | 'invalid_output';
  exitConfirmed: boolean;
  failureDiagnostic?: CompanyGitRangeUnitFailure | null;
  workerFailureCode?: CompanyV3WorkerFailureCode;
  sourceFailureReason?: CompanyGitRangeSourceFailureReason;
}

/** Only trusted harness code supplies the child and clock; no registration can choose a command or deadline. */
export const superviseCompanyV3Worker = (child: ChildProcessWithoutNullStreams, command: CompanyV3Command, id: string | null,
  startedAtMs: number, time: CompanyV3SupervisorClock = clock, diagnostics = false): Promise<CompanyV3WorkerOutcome> => new Promise(resolve => {
  const limits = getCompanyGitRangeUnitProfile().limits;
  let reason: CompanyV3WorkerOutcome['reason'] | null = null, output = Buffer.alloc(0), stderrBytes = 0;
  let diagnosticOutput = Buffer.alloc(0);
  let grace: Timer | undefined;
  const terminate = (cause: CompanyV3WorkerOutcome['reason']): void => {
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
    if (stderrBytes > 65_536) { diagnosticOutput = Buffer.alloc(0); terminate('output_limit'); }
    else if (diagnostics) diagnosticOutput = Buffer.concat([diagnosticOutput, chunk]);
  });
  child.stdout.on('error', () => terminate('worker_failed'));
  child.stderr.on('error', () => terminate('worker_failed'));
  child.on('error', () => terminate('worker_failed'));
  child.once('close', (code, signal) => {
    time.cancel(deadline); if (grace !== undefined) time.cancel(grace);
    // A valid reply alone is insufficient: process exit and the original deadline must also be confirmed.
    if (reason === null && time.now() - startedAtMs >= limits.wallClockMs) reason = 'deadline';
    const failureDiagnostic = diagnostics && command === 'plan' && id && stderrBytes <= 65_536
      ? parseCompanyV3Diagnostic(diagnosticOutput, id) : null;
    const workerFailure = diagnostics && command === 'plan' && id && stderrBytes <= 65_536
      ? parseCompanyV3WorkerFailureDetails(diagnosticOutput, id) : null;
    const diagnosticFields = diagnostics ? { failureDiagnostic } : {};
    if (reason !== null || code !== 0 || signal !== null) {
      // Only the worker's own exit 1 identifies this code; supervisor termination keeps its original cause.
      const workerFields = reason === null && code === 1 && signal === null && workerFailure
        && (!failureDiagnostic || failureDiagnostic.errorCode === workerFailure.code)
        ? { workerFailureCode: workerFailure.code,
          ...(workerFailure.sourceFailureReason === undefined ? {} : { sourceFailureReason: workerFailure.sourceFailureReason }) } : {};
      resolve({ summary: null, reason: reason ?? 'worker_failed', exitConfirmed: true, ...diagnosticFields, ...workerFields }); return;
    }
    try {
      if (failureDiagnostic || workerFailure) throw new Error('conflicting worker outputs');
      const summary = parseCompanyV3Summary(new TextDecoder('utf-8', { fatal: true }).decode(output), command, id);
      resolve({ summary, reason: 'completed', exitConfirmed: true, ...diagnosticFields });
    } catch { resolve({ summary: null, reason: 'invalid_output', exitConfirmed: true, ...diagnosticFields }); }
  });
});
