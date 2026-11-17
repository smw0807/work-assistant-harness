import { randomUUID } from 'node:crypto';
import type {
  CompanyInvestigationApprovalRequest, CompanyInvestigationModelPort, CompanyInvestigationPayload, CompanyInvestigationPlan,
  CompanyInvestigationPreparationPort, CompanyInvestigationReport, CompanyInvestigationRequest, CompanyInvestigationSnapshot,
  CompanyInvestigationSourcePort, CompanyInvestigationStore,
} from '../domain/company-investigation.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { createCompanyInvestigation, parseCompanyInvestigationResponse, validateCompanyInvestigationPayload } from '../policy/company-investigation.js';
import { assertCompanyReadonlyPlanV3, validateCompanyReadonlyPayloadV3 } from '../policy/company-readonly-v3.js';
import { assertReadonlyContext, canonicalReadonlyJson, hashReadonlyValue, isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';

const reject = (suffix: string): never => { throw new HarnessError(`COMPANY_INVESTIGATION_${suffix}`); };
const assertRequest = (request: CompanyInvestigationRequest, approval = false): void => {
  if (!readonlyExactKeys(request, approval ? ['investigationId', 'planHash', 'expiresInMinutes'] : ['investigationId', 'planHash'])
    || !isReadonlyId(request.investigationId) || !/^[a-f0-9]{64}$/.test(request.planHash)) reject('INVALID_REQUEST');
  if (approval) {
    const minutes = (request as CompanyInvestigationApprovalRequest).expiresInMinutes;
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) reject('INVALID_APPROVAL');
  }
};
const failureCode = (error: unknown): string => {
  const suffixes = ['INVALID_RESPONSE', 'OUTPUT_LIMIT', 'TIMEOUT', 'EXPIRED', 'CANCELLED', 'SOURCE_CHANGED', 'RECOVERY_UNCERTAIN'];
  if (error instanceof HarnessError) {
    const suffix = suffixes.find(value => error.code === `COMPANY_INVESTIGATION_${value}`);
    if (suffix) return `COMPANY_INVESTIGATION_${suffix}`;
  }
  return 'COMPANY_INVESTIGATION_CALL_FAILED';
};

/** Company preparation is rechecked independently; its pending state is never a call approval. */
export class CompanyInvestigationService {
  constructor(
    private readonly store: CompanyInvestigationStore,
    private readonly preparation: CompanyInvestigationPreparationPort | null,
    private readonly source: CompanyInvestigationSourcePort | null,
    private readonly model: CompanyInvestigationModelPort | null,
    private readonly clock?: () => Date,
  ) {}

  plan(preparationId: string, context: ReadonlyContext, id: string = randomUUID()): CompanyInvestigationSnapshot {
    assertReadonlyContext(context);
    if (!isReadonlyId(preparationId) || !isReadonlyId(id)) reject('INVALID_ID');
    if (!this.preparation || !this.source) return reject('PREPARATION_UNAVAILABLE');
    const snapshot = this.preparation.inspect(preparationId, this.current(context));
    const prepared = createCompanyInvestigation(snapshot, this.current(context), id, this.preparation.runtimeHash);
    this.verifyCurrent(prepared.plan, prepared.payload, context);
    return this.store.create(prepared.plan, prepared.payload, this.current(context));
  }

  approve(request: CompanyInvestigationApprovalRequest, context: ReadonlyContext): CompanyInvestigationSnapshot {
    assertReadonlyContext(context); assertRequest(request, true);
    const snapshot = this.store.inspect(request.investigationId, this.current(context));
    this.assertRequestPlan(request, snapshot);
    if (!snapshot.payload) return reject('PAYLOAD_UNAVAILABLE');
    this.verifyCurrent(snapshot.plan, snapshot.payload, context);
    return this.store.approve(request, this.current(context));
  }

  async run(request: CompanyInvestigationRequest, context: ReadonlyContext, signal?: AbortSignal): Promise<CompanyInvestigationSnapshot> {
    assertReadonlyContext(context); assertRequest(request); this.requireModel();
    const initial = this.store.inspect(request.investigationId, this.current(context));
    this.assertRequestPlan(request, initial);
    if (initial.status !== 'APPROVED' || !initial.approval || initial.approval.usedAt || initial.approval.revokedAt) return reject('APPROVAL_REQUIRED');
    if (!initial.payload) return reject('PAYLOAD_UNAVAILABLE');
    if (signal?.aborted) return this.store.cancel(request.investigationId, this.current(context));
    this.verifyCurrent(initial.plan, initial.payload, context);
    if (signal?.aborted) return this.store.cancel(request.investigationId, this.current(context));
    const claimed = this.store.claim(request, this.current(context));
    if (!claimed.attempt || !claimed.payload) return reject('INVALID_ATTEMPT');
    const { plan, payload } = claimed, attemptId = claimed.attempt.id;
    const controller = new AbortController();
    let abortCode = 'COMPANY_INVESTIGATION_CANCELLED';
    let notifyAbort: () => void = () => {};
    const aborted = new Promise<{ kind: 'aborted' }>(resolve => { notifyAbort = () => resolve({ kind: 'aborted' }); });
    const abort = (): void => { controller.abort(); notifyAbort(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const workDeadline = Date.now() + plan.executionBudget.workTimeoutMs;
    const timeout = setTimeout(() => { abortCode = 'COMPANY_INVESTIGATION_TIMEOUT'; abort(); }, plan.executionBudget.workTimeoutMs);
    const monitor = setInterval(() => {
      try { this.store.assertRunnable(request.investigationId, attemptId, this.current(context)); }
      catch { abortCode = 'COMPANY_INVESTIGATION_EXPIRED'; abort(); }
    }, 25);
    type Outcome = { kind: 'result'; value: string } | { kind: 'error'; error: unknown };
    let operation: Promise<Outcome> | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupConfirmed = true;
    let sourceVerifiedAfterCall = false;
    let report: CompanyInvestigationReport | null = null;
    let failure: string | null = null;
    const assertRunnable = (): void => {
      if (Date.now() >= workDeadline) { abortCode = 'COMPANY_INVESTIGATION_TIMEOUT'; abort(); }
      if (controller.signal.aborted) throw new HarnessError(abortCode);
      this.store.assertRunnable(request.investigationId, attemptId, this.current(context));
      this.requireModel();
    };
    try {
      operation = Promise.resolve().then(() => {
        this.verifyCurrent(plan, payload, context); assertRunnable();
        const dispatch = this.store.dispatch(request.investigationId, attemptId, this.current(context));
        validateCompanyInvestigationPayload(plan, dispatch);
        // No asynchronous gap between the final source check, reservation and local invocation.
        // Reservation is committed first, so no retry is possible after this boundary.
        assertRunnable(); return this.requireModel().investigate(dispatch.inputText, controller.signal);
      }).then(value => ({ kind: 'result' as const, value }), (error: unknown) => ({ kind: 'error' as const, error }));
      const outcome = await Promise.race([operation, aborted]);
      if (outcome.kind === 'aborted' || controller.signal.aborted) {
        const cleaned = await Promise.race([operation, new Promise<{ kind: 'uncertain' }>(resolve => {
          cleanupTimer = setTimeout(() => resolve({ kind: 'uncertain' }), plan.executionBudget.cleanupTimeoutMs);
        })]);
        cleanupConfirmed = cleaned.kind !== 'uncertain';
        throw new HarnessError(abortCode);
      }
      if (outcome.kind === 'error') throw outcome.error;
      assertRunnable();
      const result = parseCompanyInvestigationResponse(outcome.value, payload);
      this.verifyCurrent(plan, payload, context); sourceVerifiedAfterCall = true; assertRunnable();
      report = { version: 'company-investigation-report-v1', investigationId: plan.id, planHash: plan.planHash,
        preparationId: plan.preparation.id, createdAt: this.current(context).now.toISOString(), mode: 'mock', result,
        responseHash: hashReadonlyValue(canonicalReadonlyJson(result)), sourceUnchanged: true, semanticAccuracyVerified: false,
        realModel: 'not_run', nativeExecution: 'not_run', credentialAccess: 'not_run', externalTransmission: 'not_run', executionAllowed: false };
    } catch (error) {
      failure = failureCode(error);
    } finally {
      clearInterval(monitor); clearTimeout(timeout);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
    }
    if (operation && cleanupConfirmed && !sourceVerifiedAfterCall) {
      try { this.verifyCurrent(plan, payload, context); }
      catch { report = null; failure = 'COMPANY_INVESTIGATION_SOURCE_CHANGED'; }
    }
    if (signal?.aborted) this.store.cancel(request.investigationId, this.current(context));
    if (!cleanupConfirmed) { report = null; failure = 'COMPANY_INVESTIGATION_RECOVERY_UNCERTAIN'; }
    return this.store.finish(request.investigationId, attemptId, report, report ? null : failure ?? 'COMPANY_INVESTIGATION_CALL_FAILED', this.current(context));
  }

  inspect(id: string, context: ReadonlyContext): CompanyInvestigationSnapshot { return this.store.inspect(id, this.current(context)); }
  cancel(id: string, context: ReadonlyContext): CompanyInvestigationSnapshot { return this.store.cancel(id, this.current(context)); }
  recover(id: string, context: ReadonlyContext): CompanyInvestigationSnapshot { return this.store.recover(id, this.current(context)); }
  prune(context: ReadonlyContext) { return this.store.prune(this.current(context)); }

  private current(context: ReadonlyContext): ReadonlyContext {
    assertReadonlyContext(context);
    const now = this.clock ? this.clock() : new Date(Math.max(Date.now(), context.now.getTime()));
    const current = { ownerId: context.ownerId, now: new Date(now.getTime()) };
    assertReadonlyContext(current);
    if (current.now < context.now) return reject('TIME_REVERSED');
    return current;
  }

  private requireModel(): CompanyInvestigationModelPort {
    if (!this.model || this.model.mode !== 'mock') return reject('MODEL_NOT_ALLOWED');
    return this.model;
  }

  private assertRequestPlan(request: CompanyInvestigationRequest, snapshot: CompanyInvestigationSnapshot): void {
    if (snapshot.plan.id !== request.investigationId || snapshot.plan.planHash !== request.planHash) reject('PLAN_MISMATCH');
  }

  private verifyCurrent(plan: CompanyInvestigationPlan, payload: CompanyInvestigationPayload, context: ReadonlyContext): void {
    validateCompanyInvestigationPayload(plan, payload);
    if (!this.preparation || !this.source || this.preparation.runtimeHash !== plan.preparationRuntimeHash) reject('PREPARATION_UNAVAILABLE');
    const inspect = (): void => {
      const latest = this.preparation!.inspect(plan.preparation.id, this.current(context));
      assertCompanyReadonlyPlanV3(latest.plan);
      if (latest.status !== 'AWAITING_APPROVAL' || !latest.payload
        || latest.approvalCreated !== false || latest.transmissionAllowed !== false || latest.executionAllowed !== false || latest.companyPolicyVerified !== false
        || canonicalReadonlyJson(latest.plan) !== canonicalReadonlyJson(plan.preparation)
        || canonicalReadonlyJson(latest.payload) !== canonicalReadonlyJson(payload.preparation)) reject('SOURCE_CHANGED');
      validateCompanyReadonlyPayloadV3(latest.plan, latest.payload);
    };
    try {
      inspect(); this.source!.verify(payload.preparation); inspect();
    } catch { reject('SOURCE_CHANGED'); }
  }
}
