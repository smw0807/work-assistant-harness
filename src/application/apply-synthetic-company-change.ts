import type { CompanyChangeDraft } from '../domain/company-change.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { HarnessError } from '../domain/errors.js';
import type { SyntheticCompanyChangeApprovalRequest, SyntheticCompanyChangeRequest,
  SyntheticCompanyChangeSnapshot } from '../domain/synthetic-company-change.js';
import type { SyntheticCompanyChangeStore, SyntheticCompanyChangeWorkspacePort } from '../ports/synthetic-company-change.js';
import { assertCompanyChangeContext, copyCompanyChangeData, parseCompanyChangeDraft } from '../policy/company-change.js';
import { assertSyntheticCompanyChangeApprovalRequest, assertSyntheticCompanyChangeRequest,
  assertSyntheticCompanyChangeDraftForPlan, createSyntheticCompanyChangePlan } from '../policy/synthetic-company-change.js';
import { canonicalReadonlyJson, isReadonlyId } from '../policy/readonly-investigation-policy.js';

const fail = (suffix: string): never => { throw new HarnessError(`SYNTHETIC_COMPANY_CHANGE_${suffix}`); };

/** Trusted controller for a factory-created synthetic repository. It has no product check or transmission port. */
export class SyntheticCompanyChangeService {
  constructor(private readonly store: SyntheticCompanyChangeStore,
    private readonly workspace: SyntheticCompanyChangeWorkspacePort,
    private readonly clock: () => Date = () => new Date()) {}

  async prepare(input: unknown, id?: string): Promise<SyntheticCompanyChangeSnapshot> {
    this.context();
    if (id !== undefined && !isReadonlyId(id)) fail('INVALID_ID');
    const draft = parseCompanyChangeDraft(input);
    return this.withLease(async () => {
      const source = await this.workspace.observe(draft);
      const prepared = createSyntheticCompanyChangePlan(draft, source, this.context(), id);
      return this.store.create(prepared.plan, this.context());
    });
  }

  async approve(request: SyntheticCompanyChangeApprovalRequest, input: unknown): Promise<SyntheticCompanyChangeSnapshot> {
    assertSyntheticCompanyChangeApprovalRequest(request);
    const copiedRequest = copyCompanyChangeData(request);
    const snapshot = this.inspect(copiedRequest.taskId);
    if (snapshot.plan.planHash !== copiedRequest.planHash) fail('PLAN_MISMATCH');
    if (!['AWAITING_APPROVAL', 'APPROVED'].includes(snapshot.status)) fail('APPROVAL_UNAVAILABLE');
    const draft = this.draftFor(snapshot, input);
    return this.withLease(async () => {
      await this.verifySource(snapshot, draft);
      return this.store.approve(copiedRequest, this.context());
    });
  }

  async apply(request: SyntheticCompanyChangeRequest, input: unknown): Promise<SyntheticCompanyChangeSnapshot> {
    assertSyntheticCompanyChangeRequest(request);
    const copiedRequest = copyCompanyChangeData(request);
    const snapshot = this.inspect(copiedRequest.taskId);
    if (snapshot.plan.planHash !== copiedRequest.planHash) fail('PLAN_MISMATCH');
    if (snapshot.status !== 'APPROVED') fail('APPROVAL_UNAVAILABLE');
    const draft = this.draftFor(snapshot, input);
    return this.withLease(async () => {
      await this.verifySource(snapshot, draft);
      // Consumption is committed before the first branch or file mutation. It is never reverted.
      const claimed = this.store.claim(copiedRequest, this.context());
      try {
        this.assertWriteDeadline(claimed);
        this.store.record(claimed.plan.id, { kind: 'branch', path: null, state: 'INTENT' }, this.context());
        await this.workspace.createBranch(claimed.plan, draft);
        this.store.record(claimed.plan.id, { kind: 'branch', path: null, state: 'DONE' }, this.context());
        for (let index = 0; index < draft.changes.length; index++) {
          const path = draft.changes[index]!.path;
          this.assertWriteDeadline(claimed);
          this.store.record(claimed.plan.id, { kind: 'file', path, state: 'INTENT' }, this.context());
          await this.workspace.writeFile(claimed.plan, draft, index);
          this.store.record(claimed.plan.id, { kind: 'file', path, state: 'DONE' }, this.context());
        }
        await this.workspace.verifyApplied(claimed.plan, draft);
        return this.store.finish(claimed.plan.id, 'APPLIED', null, this.context());
      } catch {
        // A failed write or journal update can leave partial files. No cleanup, retry or rollback is implied.
        try {
          return this.store.finish(claimed.plan.id, 'FAILED', 'SYNTHETIC_COMPANY_CHANGE_APPLY_FAILED', this.context());
        } catch { return fail('OUTCOME_UNKNOWN'); }
      }
    });
  }

  inspect(id: string): SyntheticCompanyChangeSnapshot {
    if (!isReadonlyId(id)) fail('INVALID_ID');
    return this.store.inspect(id, this.context());
  }

  cancel(id: string): SyntheticCompanyChangeSnapshot {
    if (!isReadonlyId(id)) fail('INVALID_ID');
    return this.store.cancel(id, this.context());
  }

  private context(): ReadonlyContext {
    const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date(this.clock().getTime()) };
    assertCompanyChangeContext(context);
    return context;
  }

  private draftFor(snapshot: SyntheticCompanyChangeSnapshot, input: unknown): CompanyChangeDraft {
    const draft = parseCompanyChangeDraft(input);
    assertSyntheticCompanyChangeDraftForPlan(snapshot.plan, draft);
    return draft;
  }

  private async verifySource(snapshot: SyntheticCompanyChangeSnapshot, draft: CompanyChangeDraft): Promise<void> {
    const observed = await this.workspace.observe(draft);
    if (canonicalReadonlyJson(observed) !== canonicalReadonlyJson(snapshot.plan.source)) fail('SOURCE_CHANGED');
  }

  private assertWriteDeadline(snapshot: SyntheticCompanyChangeSnapshot): void {
    const now = this.context().now.toISOString();
    if (!snapshot.approval || now >= snapshot.plan.expiresAt || now >= snapshot.approval.expiresAt) fail('EXPIRED');
  }

  private async withLease<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.workspace.acquire();
    try { return await operation(); }
    finally { await lease.release(); }
  }
}
