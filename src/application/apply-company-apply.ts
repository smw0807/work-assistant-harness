import type { CompanyChangeDraft } from '../domain/company-change.js';
import { setImmediate as yieldToSignals } from 'node:timers/promises';
import type { CompanyApplyRegistration, CompanyApplySource } from '../domain/company-apply.js';
import { HarnessError } from '../domain/errors.js';
import { CompanyApplyJournal, observeCompanyApplyJournal, readCompanyApplyClaim,
  type CompanyApplyObservation } from '../adapters/company-apply-journal.js';
import { CompanyApplyWorkspace } from '../adapters/company-apply-workspace.js';
import { assertCompanyApplyContext, assertCompanyApplyDraftForPlan, parseCompanyApplyDraft, parseCompanyApplyRegistration } from '../policy/company-apply.js';

export interface CompanyApplyMutationPort {
  prepare(source: CompanyApplySource): Promise<void>;
  createBranch(): Promise<void>;
  writeFile(index: number): Promise<void>;
  verifyApplied(): Promise<void>;
  close(): Promise<void>;
}

/** Runs only in the isolated writer. The durable claim precedes this entry point; no model or shell port exists. */
export const applyClaimedCompanyApply = async (registrationInput: CompanyApplyRegistration, draftInput: CompanyChangeDraft,
  directory: string, workspaceFactory: (registration: CompanyApplyRegistration, draft: CompanyChangeDraft, id: string) => CompanyApplyMutationPort
    = (registration, draft, id) => new CompanyApplyWorkspace(registration, draft, id),
  clock: () => Date = () => new Date()): Promise<CompanyApplyObservation> => {
  const registration = parseCompanyApplyRegistration(registrationInput), draft = parseCompanyApplyDraft(draftInput, registration);
  const claim = await readCompanyApplyClaim(directory);
  assertCompanyApplyDraftForPlan(claim.plan, draft, registration);
  const assertLive = (): void => {
    const now = assertCompanyApplyContext({ ownerId: claim.plan.ownerId, now: clock() });
    if (now < claim.approval.usedAt! || now >= claim.approval.expiresAt) throw new HarnessError('COMPANY_APPLY_APPROVAL_UNAVAILABLE');
  };
  // Let stdin EOF, TERM and the worker watchdog run before each new synchronous filesystem mutation.
  const checkpoint = async (): Promise<void> => { await yieldToSignals(); assertLive(); };
  assertLive();
  const workspace = workspaceFactory(registration, draft, claim.plan.id), journal = await CompanyApplyJournal.open(directory);
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
    } catch { throw new HarnessError('COMPANY_APPLY_OUTCOME_UNKNOWN'); }
  } finally {
    try { if (!closed) await workspace.close(); } finally { await journal.close(); }
  }
  return observeCompanyApplyJournal(directory);
};
