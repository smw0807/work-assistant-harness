import { randomUUID } from 'node:crypto';
import type { CompanyInvestigationPreparationPort, CompanyInvestigationSourcePort } from '../domain/company-investigation.js';
import type { CompanyRelayApprovalRequest, CompanyRelayAuthorization, CompanyRelayPayload, CompanyRelayPlan,
  CompanyRelayReport, CompanyRelayRequest, CompanyRelaySnapshot, CompanyRelayStore } from '../domain/company-relay.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS } from '../domain/readonly-relay.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../ports/readonly-relay.js';
import { assertCompanyRelayAuthorizationAllowed, assertCompanyRelayReport, copyCompanyRelayData, createCompanyRelay, parseCompanyRelayAuthorization, parseCompanyRelayResponse,
  validateCompanyRelayPayload } from '../policy/company-relay.js';
import { assertCompanyReadonlyPlanV3, validateCompanyReadonlyPayloadV3 } from '../policy/company-readonly-v3.js';
import { assertReadonlyContext, canonicalReadonlyJson, hashReadonlyValue, isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';

export type CompanyRelayFactory = (plan: CompanyRelayPlan) => ReadonlyRelayPort;
const reject = (suffix: string): never => { throw new HarnessError(`COMPANY_RELAY_${suffix}`); };
const assertRequest = (request: CompanyRelayRequest, approval = false): void => {
  if (!readonlyExactKeys(request, approval ? ['investigationId', 'planHash', 'expiresInMinutes'] : ['investigationId', 'planHash'])
    || !isReadonlyId(request.investigationId) || !/^[a-f0-9]{64}$/u.test(request.planHash)) reject('INVALID_REQUEST');
  if (approval) {
    const minutes = (request as CompanyRelayApprovalRequest).expiresInMinutes;
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) reject('INVALID_APPROVAL');
  }
};
const failureCode = (error: unknown): string => {
  if (error instanceof HarnessError) {
    if (error.code === 'READONLY_RELAY_LIFECYCLE_UNSAFE') return 'COMPANY_RELAY_RECOVERY_UNCERTAIN';
    const suffix = ['INVALID_RESPONSE', 'INVALID_REPORT', 'OUTPUT_LIMIT', 'TIMEOUT', 'EXPIRED', 'CANCELLED', 'SOURCE_CHANGED',
      'RECOVERY_UNCERTAIN', 'ACCOUNT_MISMATCH', 'INVALID_TRANSPORT', 'CONFIG_CHANGED'].find(value =>
      error.code === `COMPANY_RELAY_${value}` || error.code === `READONLY_RELAY_${value}`);
    if (suffix) return `COMPANY_RELAY_${suffix}`;
  }
  return 'COMPANY_RELAY_CALL_FAILED';
};

/** Preparation permission, company transmission policy and a single-use call approval remain separate. */
export class CompanyRelayService {
  constructor(
    private readonly store: CompanyRelayStore,
    private readonly preparation: CompanyInvestigationPreparationPort | null,
    private readonly source: CompanyInvestigationSourcePort | null,
    private readonly relayFactory: CompanyRelayFactory | null,
    private readonly authorization: CompanyRelayAuthorization | null,
    private readonly clock?: () => Date,
  ) {}

  plan(preparationId: string, context: ReadonlyContext, id: string = randomUUID()): CompanyRelaySnapshot {
    assertReadonlyContext(context);
    if (!isReadonlyId(preparationId) || !isReadonlyId(id)) reject('INVALID_ID');
    if (!this.preparation || !this.source || !this.authorization) return reject('PREPARATION_UNAVAILABLE');
    assertCompanyRelayAuthorizationAllowed(this.authorization);
    const snapshot = this.preparation.inspect(preparationId, this.current(context));
    const prepared = createCompanyRelay(snapshot, this.current(context), id, this.preparation.runtimeHash, this.authorization);
    this.verifyCurrent(prepared.plan, prepared.payload, context);
    return this.store.create(prepared.plan, prepared.payload, this.current(context));
  }

  approve(request: CompanyRelayApprovalRequest, context: ReadonlyContext): CompanyRelaySnapshot {
    assertReadonlyContext(context); assertRequest(request, true);
    const snapshot = this.store.inspect(request.investigationId, this.current(context));
    this.assertRequestPlan(request, snapshot);
    if (!snapshot.payload) return reject('PAYLOAD_UNAVAILABLE');
    this.verifyCurrent(snapshot.plan, snapshot.payload, context);
    return this.store.approve(request, this.current(context));
  }

  async run(request: CompanyRelayRequest, context: ReadonlyContext, signal?: AbortSignal): Promise<CompanyRelaySnapshot> {
    assertReadonlyContext(context); assertRequest(request);
    if (typeof this.relayFactory !== 'function') return reject('TRANSPORT_UNAVAILABLE');
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
    let abortCode = 'COMPANY_RELAY_CANCELLED';
    let notifyAbort: () => void = () => {};
    const aborted = new Promise<{ kind: 'aborted' }>(resolve => { notifyAbort = () => resolve({ kind: 'aborted' }); });
    const abort = (): void => { controller.abort(); notifyAbort(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const workDeadline = Date.now() + plan.executionBudget.workTimeoutMs;
    const timeout = setTimeout(() => { abortCode = 'COMPANY_RELAY_TIMEOUT'; abort(); }, plan.executionBudget.workTimeoutMs);
    const monitor = setInterval(() => {
      try { this.store.assertRunnable(request.investigationId, attemptId, this.current(context)); }
      catch { abortCode = 'COMPANY_RELAY_EXPIRED'; abort(); }
    }, 25);
    type Outcome = { kind: 'result'; value: ReadonlyRelayTransmissionResult } | { kind: 'error'; error: unknown };
    let operation: Promise<Outcome> | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupConfirmed = true, sourceVerifiedAfterCall = false, protocolFailed = false;
    let credentialChecks = 0, transmissions = 0;
    let report: CompanyRelayReport | null, failure: string | null = null;
    const assertRunnable = (): void => {
      if (Date.now() >= workDeadline) { abortCode = 'COMPANY_RELAY_TIMEOUT'; abort(); }
      if (controller.signal.aborted) throw new HarnessError(abortCode);
      this.store.assertRunnable(request.investigationId, attemptId, this.current(context));
    };
    const beforeCredentialAccess = (): void => {
      try {
        if (protocolFailed || credentialChecks !== 0 || transmissions !== 0) reject('INVALID_TRANSPORT');
        credentialChecks++;
        this.verifyCurrent(plan, payload, context); assertRunnable();
      } catch (error) { protocolFailed = true; throw error; }
    };
    const beforeTransmission = (): void => {
      try {
        if (protocolFailed || credentialChecks !== 1 || transmissions !== 0) reject('INVALID_TRANSPORT');
        this.verifyCurrent(plan, payload, context); assertRunnable();
        const reserved = this.store.dispatch(request.investigationId, attemptId, this.current(context));
        validateCompanyRelayPayload(plan, reserved);
        if (canonicalReadonlyJson(reserved) !== canonicalReadonlyJson(payload)) reject('INVALID_TRANSPORT');
        transmissions++;
        // The durable reservation precedes the actual transport call, without an asynchronous gap.
        assertRunnable();
      } catch (error) { protocolFailed = true; throw error; }
    };
    try {
      operation = Promise.resolve().then(async () => {
        this.verifyCurrent(plan, payload, context); assertRunnable();
        // Even constructing or probing a real adapter is deferred until approval has been consumed.
        const relay = this.relayFactory!(copyCompanyRelayData(plan));
        if (!relay || relay.mode !== 'live' || relay.transport !== 'codex-cli-relay' || typeof relay.transmit !== 'function'
          || (relay.verifyReady !== undefined && typeof relay.verifyReady !== 'function')) reject('INVALID_TRANSPORT');
        await relay.verifyReady?.();
        this.verifyCurrent(plan, payload, context); assertRunnable();
        const dispatch = copyCompanyRelayData({ requestEnvelope: payload.requestEnvelope, requestEnvelopeHash: payload.requestEnvelopeHash,
          requestBodyHash: payload.requestBodyHash });
        dispatch.requestEnvelope.headers.forEach(Object.freeze); Object.freeze(dispatch.requestEnvelope.headers);
        Object.freeze(dispatch.requestEnvelope); Object.freeze(dispatch);
        return relay.transmit(dispatch, controller.signal, beforeTransmission, beforeCredentialAccess);
      }).then(value => ({ kind: 'result' as const, value }), (error: unknown) => ({ kind: 'error' as const, error }));
      const outcome = await Promise.race([operation, aborted]);
      if (outcome.kind === 'aborted' || controller.signal.aborted) {
        const cleaned = await Promise.race([operation, new Promise<{ kind: 'uncertain' }>(resolve => {
          cleanupTimer = setTimeout(() => resolve({ kind: 'uncertain' }), plan.executionBudget.cleanupTimeoutMs);
        })]);
        cleanupConfirmed = cleaned.kind !== 'uncertain'
          && !(cleaned.kind === 'error' && failureCode(cleaned.error) === 'COMPANY_RELAY_RECOVERY_UNCERTAIN');
        throw new HarnessError(abortCode);
      }
      if (outcome.kind === 'error') throw outcome.error;
      assertRunnable();
      if (protocolFailed || credentialChecks !== 1 || transmissions !== 1) reject('INVALID_TRANSPORT');
      const response = copyCompanyRelayData(outcome.value);
      if (!readonlyExactKeys(response, ['text', 'responseHash', 'finalTextHash', 'verification'])
        || typeof response.text !== 'string' || response.finalTextHash !== hashReadonlyValue(response.text)) reject('INVALID_RESPONSE');
      const result = parseCompanyRelayResponse(response.text, payload);
      this.verifyCurrent(plan, payload, context); sourceVerifiedAfterCall = true; assertRunnable();
      const live = response.verification.transport === 'live';
      report = { version: 'company-relay-report-v1', investigationId: plan.id, planHash: plan.planHash,
        preparationId: plan.preparation.id, createdAt: this.current(context).now.toISOString(), mode: 'live', transport: 'codex-cli-relay', result,
        resultHash: hashReadonlyValue(canonicalReadonlyJson(result)), responseHash: response.responseHash, finalTextHash: response.finalTextHash,
        verification: response.verification, sourceUnchanged: true, semanticAccuracyVerified: false,
        realModel: live ? 'passed' : 'not_run', nativeExecution: response.verification.isolation === 'passed' ? 'passed' : 'not_run',
        credentialAccess: response.verification.credentialAccess, externalTransmission: live ? 'passed' : 'not_run',
        unverifiedResponseChecks: READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS, executionAllowed: false };
      assertCompanyRelayReport(plan, payload, report);
    } catch (error) {
      failure = failureCode(error); report = null;
      if (failure === 'COMPANY_RELAY_RECOVERY_UNCERTAIN') cleanupConfirmed = false;
    }
    finally {
      clearInterval(monitor); clearTimeout(timeout);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
    }
    if (operation && cleanupConfirmed && !sourceVerifiedAfterCall) {
      try { this.verifyCurrent(plan, payload, context); }
      catch (error) {
        report = null;
        const currentFailure = failureCode(error);
        failure = currentFailure === 'COMPANY_RELAY_CALL_FAILED' ? 'COMPANY_RELAY_SOURCE_CHANGED' : currentFailure;
      }
    }
    if (signal?.aborted) this.store.cancel(request.investigationId, this.current(context));
    if (!cleanupConfirmed) { report = null; failure = 'COMPANY_RELAY_RECOVERY_UNCERTAIN'; }
    return this.store.finish(request.investigationId, attemptId, report, report ? null : failure ?? 'COMPANY_RELAY_CALL_FAILED', this.current(context));
  }

  inspect(id: string, context: ReadonlyContext): CompanyRelaySnapshot { return this.store.inspect(id, this.current(context)); }
  cancel(id: string, context: ReadonlyContext): CompanyRelaySnapshot { return this.store.cancel(id, this.current(context)); }
  recover(id: string, context: ReadonlyContext): CompanyRelaySnapshot { return this.store.recover(id, this.current(context)); }
  prune(context: ReadonlyContext) { return this.store.prune(this.current(context)); }

  private current(context: ReadonlyContext): ReadonlyContext {
    assertReadonlyContext(context);
    const now = this.clock ? this.clock() : new Date(Math.max(Date.now(), context.now.getTime()));
    const current = { ownerId: context.ownerId, now: new Date(now.getTime()) };
    assertReadonlyContext(current);
    if (current.now < context.now) return reject('TIME_REVERSED');
    return current;
  }

  private assertRequestPlan(request: CompanyRelayRequest, snapshot: CompanyRelaySnapshot): void {
    if (snapshot.plan.id !== request.investigationId || snapshot.plan.planHash !== request.planHash) reject('PLAN_MISMATCH');
  }

  private verifyCurrent(plan: CompanyRelayPlan, payload: CompanyRelayPayload, context: ReadonlyContext): void {
    validateCompanyRelayPayload(plan, payload);
    if (!this.authorization) reject('CONFIG_CHANGED');
    try {
      const authorization = parseCompanyRelayAuthorization(this.authorization);
      if (!authorization.enabled || !authorization.companyTransmissionApproved || !authorization.providerTermsConfirmed
        || !authorization.config.enabled || canonicalReadonlyJson(authorization) !== canonicalReadonlyJson(plan.policyDeclaration)) reject('CONFIG_CHANGED');
    } catch { reject('CONFIG_CHANGED'); }
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
    try { inspect(); this.source!.verify(payload.preparation); inspect(); }
    catch { reject('SOURCE_CHANGED'); }
  }
}
