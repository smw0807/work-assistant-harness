import type { CompanyChangeDraft } from '../domain/company-change.js';
import { setImmediate as yieldToSignals } from 'node:timers/promises';
import type { CompanyWriteRegistration, CompanyWriteSource } from '../domain/company-write.js';
import { HarnessError } from '../domain/errors.js';
import { CompanyWriteJournal, observeCompanyWriteJournal, readCompanyWriteClaim,
  type CompanyWriteObservation } from '../adapters/company-write-journal.js';
import { CompanyWriteWorkspace } from '../adapters/company-write-workspace.js';
import { assertCompanyWriteContext, assertCompanyWriteDraftForPlan, parseCompanyWriteDraft, parseCompanyWriteRegistration } from '../policy/company-write.js';

export interface CompanyWriteMutationPort {
  prepare(source: CompanyWriteSource): Promise<void>;
  createBranch(): Promise<void>;
  writeFile(index: number): Promise<void>;
  verifyApplied(): Promise<void>;
  close(): Promise<void>;
}

/** Runs only in the isolated writer. The durable claim precedes this entry point; no model or shell port exists. */
export const applyClaimedCompanyWrite = async (registrationInput: CompanyWriteRegistration, draftInput: CompanyChangeDraft,
  directory: string, workspaceFactory: (registration: CompanyWriteRegistration, draft: CompanyChangeDraft, id: string) => CompanyWriteMutationPort
    = (registration, draft, id) => new CompanyWriteWorkspace(registration, draft, id),
  clock: () => Date = () => new Date()): Promise<CompanyWriteObservation> => {
  const registration = parseCompanyWriteRegistration(registrationInput), draft = parseCompanyWriteDraft(draftInput, registration);
  const claim = await readCompanyWriteClaim(directory);
  assertCompanyWriteDraftForPlan(claim.plan, draft, registration);
  const assertLive = (): void => {
    const now = assertCompanyWriteContext({ ownerId: claim.plan.ownerId, now: clock() });
    if (now < claim.approval.usedAt! || now >= claim.approval.expiresAt) throw new HarnessError('COMPANY_WRITE_APPROVAL_UNAVAILABLE');
  };
  // Let stdin EOF, TERM and the worker watchdog run before each new synchronous filesystem mutation.
  const checkpoint = async (): Promise<void> => { await yieldToSignals(); assertLive(); };
  assertLive();
  const workspace = workspaceFactory(registration, draft, claim.plan.id), journal = await CompanyWriteJournal.open(directory);
  let closed = false;
  try {
    await workspace.prepare(claim.plan.source); await checkpoint();
    await journal.record('branch', null, 'INTENT', clock()); await checkpoint();
    await workspace.createBranch(); await journal.record('branch', null, 'DONE', clock());
    for (let index = 0; index < draft.changes.length; index++) {
      const path = draft.changes[index]!.path;
      await checkpoint(); await journal.record('file', path, 'INTENT', clock()); await checkpoint();
      await workspace.writeFile(index); await journal.record('file', path, 'DONE', clock());
    }
    await workspace.verifyApplied(); await workspace.close(); closed = true;
    await journal.record('result', null, 'APPLIED', clock());
  } catch {
    // Preserve every completed mutation and the consumed approval, including an uncertain last INTENT.
    try {
      if (!closed) { await workspace.close(); closed = true; }
      await journal.record('result', null, 'FAILED', clock());
    } catch { throw new HarnessError('COMPANY_WRITE_OUTCOME_UNKNOWN'); }
  } finally {
    try { if (!closed) await workspace.close(); } finally { await journal.close(); }
  }
  return observeCompanyWriteJournal(directory);
};
