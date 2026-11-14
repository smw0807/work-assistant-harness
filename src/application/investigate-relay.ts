import { randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext, ReadonlySelection } from '../domain/readonly-investigation.js';
import { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS, type ReadonlyRelayConfig, type ReadonlyRelayPlan } from '../domain/readonly-relay.js';
import type {
  ReadonlyRelayApproval, ReadonlyRelayApprovalRequest, ReadonlyRelayPort, ReadonlyRelayPruneResult,
  ReadonlyRelayReport, ReadonlyRelayRunRequest, ReadonlyRelaySnapshot, ReadonlyRelayStore, ReadonlyRelayTransmissionResult,
} from '../ports/readonly-relay.js';
import { assertReadonlyContext, defaultReadonlySelection, hashReadonlyValue, isReadonlyId, readonlyExactKeys, selectReadonlyTransfer } from '../policy/readonly-investigation-policy.js';
import {
  assertReadonlyRelayDispatch, createReadonlyRelayPayload, createReadonlyRelayPlan, getReadonlyRelayProfileId, parseReadonlyRelayConfig,
  parseReadonlyRelayResult, validateReadonlyRelayPayload,
} from '../policy/readonly-relay-policy.js';
import { assertReadonlyRepository, assertReadonlyRepositoryNow, collectReadonlyPayload, prepareReadonlyRepository } from '../adapters/readonly-repository.js';

type CleanupHashes = Pick<ReadonlyRelayPlan, 'requestBodyHash' | 'requestEnvelopeHash' | 'connectionProfileHash'>;
const hashes = (plan: ReadonlyRelayPlan): CleanupHashes => ({ requestBodyHash: plan.requestBodyHash,
  requestEnvelopeHash: plan.requestEnvelopeHash, connectionProfileHash: plan.connectionProfileHash });
const currentContext = (context: ReadonlyContext): ReadonlyContext => ({ ownerId: context.ownerId, now: new Date(Math.max(Date.now(), context.now.getTime())) });
const safeFailure = (error: unknown): string => {
  if (error instanceof HarnessError && error.code === 'READONLY_RELAY_LIFECYCLE_UNSAFE') return 'READONLY_RELAY_RECOVERY_UNCERTAIN';
  const allowed = ['READONLY_RELAY_INVALID_RESPONSE', 'READONLY_RELAY_OUTPUT_LIMIT', 'READONLY_RELAY_TIMEOUT', 'READONLY_RELAY_EXPIRED', 'READONLY_RELAY_SOURCE_CHANGED'];
  return error instanceof HarnessError && allowed.includes(error.code) ? error.code : 'READONLY_RELAY_CALL_FAILED';
};
const assertResponse = (raw: ReadonlyRelayTransmissionResult): void => {
  if (!readonlyExactKeys(raw, ['text', 'responseHash', 'finalTextHash', 'verification']) || typeof raw.text !== 'string'
    || Buffer.from(raw.text).toString('utf8') !== raw.text || !/^[a-f0-9]{64}$/u.test(raw.responseHash)
    || raw.finalTextHash !== hashReadonlyValue(raw.text)
    || !readonlyExactKeys(raw.verification, ['transport', 'upstreamCalls', 'isolation', 'credentialAccess', 'responseValidation', 'relayCompleted', 'credentialReflection'])
    || !['live', 'fake'].includes(raw.verification.transport) || raw.verification.upstreamCalls !== 1
    || !['passed', 'not_run'].includes(raw.verification.isolation) || !['passed', 'not_run'].includes(raw.verification.credentialAccess)
    || raw.verification.responseValidation !== 'codex-native-output-v1' || raw.verification.relayCompleted !== true
    || raw.verification.credentialReflection !== 'passed'
    || (raw.verification.transport === 'live' && (raw.verification.isolation !== 'passed' || raw.verification.credentialAccess !== 'passed'))) {
    throw new HarnessError('READONLY_RELAY_INVALID_RESPONSE');
  }
  if (Buffer.byteLength(raw.text) > 16 * 1024) throw new HarnessError('READONLY_RELAY_OUTPUT_LIMIT');
};

/** 승인된 합성 근거만 한 번 전송하고 결과를 로컬에 보관한다. 실행·수정·내보내기는 제공하지 않는다. */
export class ReadonlyRelayService {
  constructor(
    private readonly store: ReadonlyRelayStore,
    private readonly port: ReadonlyRelayPort,
    private readonly dataDirectory: string,
    private readonly config?: ReadonlyRelayConfig,
    private readonly cleanupVerifier?: (id: string, hashes: CleanupHashes) => boolean,
  ) { this.assertPort(); }

  async plan(fixtureId: string, selection: ReadonlySelection | undefined, context: ReadonlyContext,
    transferPreset: 'all' | 'controller' | 'service' = 'all'): Promise<ReadonlyRelaySnapshot> {
    assertReadonlyContext(context);
    const config = this.requireConfig(false);
    this.store.prune(context);
    if (fixtureId !== 'flow') throw new HarnessError('READONLY_RELAY_INVALID_FIXTURE');
    if (!['all', 'controller', 'service'].includes(transferPreset)) throw new HarnessError('READONLY_RELAY_INVALID_SELECTION');
    const repository = await prepareReadonlyRepository(this.dataDirectory, randomUUID(), fixtureId);
    let payload = await collectReadonlyPayload(repository, selection ?? defaultReadonlySelection(), context);
    if (transferPreset !== 'all') payload = selectReadonlyTransfer(payload, payload.context.evidence.filter((item) => item.path === `src/${transferPreset}.ts`).map((item) => item.evidenceId));
    const profileId = getReadonlyRelayProfileId(config);
    const livePayload = createReadonlyRelayPayload(payload, profileId, config);
    const plan = createReadonlyRelayPlan(livePayload, context, config);
    await assertReadonlyRepository(repository);
    return this.store.create(plan, livePayload, context);
  }

  inspect(id: string, context: ReadonlyContext, offset = 0): ReadonlyRelaySnapshot { return this.store.inspect(id, context, offset); }

  approve(request: ReadonlyRelayApprovalRequest, context: ReadonlyContext): ReadonlyRelayApproval {
    this.assertPort();
    const config = this.requireConfig(true);
    if (!readonlyExactKeys(request, ['investigationId', 'planHash', 'expiresInMinutes']) || !isReadonlyId(request.investigationId)) throw new HarnessError('READONLY_RELAY_INVALID_APPROVAL');
    const snapshot = this.store.inspect(request.investigationId, context);
    if (!snapshot.payload) throw new HarnessError('READONLY_RELAY_PAYLOAD_UNAVAILABLE');
    validateReadonlyRelayPayload(snapshot.task.plan, snapshot.payload, config);
    return this.store.approve(request, context);
  }

  async run(request: ReadonlyRelayRunRequest, context: ReadonlyContext, signal?: AbortSignal): Promise<ReadonlyRelaySnapshot> {
    assertReadonlyContext(context);
    this.assertPort();
    const config = this.requireConfig(true);
    if (!readonlyExactKeys(request, ['investigationId', 'planHash']) || !isReadonlyId(request.investigationId)) throw new HarnessError('READONLY_RELAY_INVALID_RUN');
    let snapshot = this.store.inspect(request.investigationId, currentContext(context));
    if (!snapshot.payload) throw new HarnessError('READONLY_RELAY_PAYLOAD_UNAVAILABLE');
    validateReadonlyRelayPayload(snapshot.task.plan, snapshot.payload, config);
    await assertReadonlyRepository(snapshot.payload.repository);
    if (signal?.aborted) return this.store.cancel(request.investigationId, currentContext(context));
    // 설치 파일 부재는 승인을 소비하지 않는다. 비동기 준비 뒤 승인·시간·취소를 다시 검사한다.
    await this.port.verifyReady?.();
    if (signal?.aborted) return this.store.cancel(request.investigationId, currentContext(context));
    this.assertPort();
    snapshot = this.store.inspect(request.investigationId, currentContext(context));
    if (!snapshot.payload) throw new HarnessError('READONLY_RELAY_PAYLOAD_UNAVAILABLE');
    validateReadonlyRelayPayload(snapshot.task.plan, snapshot.payload, config);
    const payload = snapshot.payload;
    const plan = snapshot.task.plan;
    const attempt = this.store.claim(request, currentContext(context));
    const controller = new AbortController();
    let timedOut = false;
    let monitoringFailure = false;
    let notifyAbort: () => void = () => {};
    const aborted = new Promise<{ kind: 'abort' }>((resolve) => { notifyAbort = () => resolve({ kind: 'abort' }); });
    const abort = (): void => { controller.abort(); notifyAbort(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => { timedOut = true; abort(); }, plan.limits.responseTimeoutMs);
    const monitor = setInterval(() => {
      try { this.store.assertRunnable(request.investigationId, attempt.generation, currentContext(context)); }
      catch { monitoringFailure = true; abort(); }
    }, 25);
    type Outcome = { kind: 'result'; value: ReadonlyRelayTransmissionResult } | { kind: 'error'; error: unknown };
    let transmission: Promise<Outcome> | null = null;
    let report: ReadonlyRelayReport | null = null;
    let failureCode: string | null = null;
    let cleanupConfirmed = true;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assertReadonlyRepository(payload.repository);
      let transmissionChecks = 0;
      const assertCurrent = (): void => {
        this.assertPort();
        if (controller.signal.aborted) throw new HarnessError('READONLY_RELAY_CANCELLED');
        this.store.assertRunnable(request.investigationId, attempt.generation, currentContext(context));
      };
      const beforeCredentialAccess = (): void => {
        try { assertReadonlyRepositoryNow(payload.repository); }
        catch { throw new HarnessError('READONLY_RELAY_SOURCE_CHANGED'); }
        assertCurrent();
      };
      const beforeTransmission = (): void => {
        if (++transmissionChecks !== 1) throw new HarnessError('READONLY_RELAY_ALREADY_DISPATCHED');
        beforeCredentialAccess();
      };
      assertCurrent();
      const call = this.store.dispatch(request.investigationId, attempt.generation, currentContext(context), (dispatch) => {
        assertReadonlyRelayDispatch(dispatch, config);
        const approved = structuredClone(dispatch);
        approved.requestEnvelope.headers.forEach((header) => Object.freeze(header));
        Object.freeze(approved.requestEnvelope.headers); Object.freeze(approved.requestEnvelope); Object.freeze(approved);
        return this.port.transmit(approved, controller.signal, beforeTransmission, beforeCredentialAccess);
      });
      transmission = Promise.resolve(call).then((value): Outcome => ({ kind: 'result', value }), (error: unknown): Outcome => ({ kind: 'error', error }));
      const outcome = await Promise.race([transmission, aborted]);
      if (outcome.kind === 'abort' || controller.signal.aborted) {
        const cleanup = await Promise.race([transmission, new Promise<{ kind: 'uncertain' }>((resolve) => {
          cleanupTimer = setTimeout(() => resolve({ kind: 'uncertain' }), plan.limits.cleanupTimeoutMs);
        })]);
        cleanupConfirmed = cleanup.kind !== 'uncertain' && !(cleanup.kind === 'error' && safeFailure(cleanup.error) === 'READONLY_RELAY_RECOVERY_UNCERTAIN');
        throw new HarnessError(timedOut ? 'READONLY_RELAY_TIMEOUT' : 'READONLY_RELAY_CANCELLED');
      }
      if (outcome.kind === 'error') throw outcome.error;
      const raw = outcome.value;
      if (transmissionChecks !== 1) throw new HarnessError('READONLY_RELAY_INVALID_RESPONSE');
      assertResponse(raw);
      const { mode, transport, responseOrigin, classification, summary, facts, hypotheses, answerDraft, questions, suggestions, limitations } = parseReadonlyRelayResult(raw.text, payload);
      const live = raw.verification.transport === 'live' ? 'passed' : 'not_run';
      report = { mode, transport, responseOrigin, investigationId: request.investigationId, planHash: plan.planHash,
        contextHash: plan.contextHash, inputHash: plan.inputHash, requestBodyHash: plan.requestBodyHash,
        connectionProfileHash: plan.connectionProfileHash, requestEnvelopeHash: plan.requestEnvelopeHash, responseHash: raw.responseHash,
        finalTextHash: raw.finalTextHash,
        result: { classification, summary, facts, hypotheses, answerDraft, questions, suggestions, limitations },
        createdAt: currentContext(context).now.toISOString(), targetUnchanged: true, executionAllowed: false, semanticAccuracyVerified: false,
        verification: structuredClone(raw.verification), contractVerified: { profile: 'passed', envelope: 'passed', cliOutput: 'passed', evidence: 'passed' },
        unverifiedResponseChecks: { ...READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS },
        excludedOperationsReason: 'readonly-relay-only', checks: { sourceUnchanged: 'passed', targetCodeExecution: 'not_run', realModel: live,
          externalTransmission: live, credentialAccess: raw.verification.credentialAccess, providerCompatibility: live,
          liveIsolation: raw.verification.isolation, semanticAccuracy: 'not_run' } };
    } catch (error) {
      failureCode = safeFailure(error);
      if (failureCode === 'READONLY_RELAY_RECOVERY_UNCERTAIN') cleanupConfirmed = false;
    } finally {
      // 어댑터의 종료 확인 또는 제한된 정리 대기가 끝난 후에만 타이머와 취소 감시를 해제한다.
      clearInterval(monitor); clearTimeout(timeout);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
    }
    if (transmission && this.cleanupVerifier) {
      try { cleanupConfirmed = cleanupConfirmed && this.cleanupVerifier(request.investigationId, hashes(plan)); }
      catch { cleanupConfirmed = false; }
    }
    let sourceUnchanged = true;
    try { await assertReadonlyRepository(payload.repository); }
    catch { sourceUnchanged = false; }
    const finish = currentContext(context);
    if (signal?.aborted) this.store.cancel(request.investigationId, finish);
    if (timedOut) { report = null; failureCode = 'READONLY_RELAY_TIMEOUT'; }
    if (monitoringFailure) { report = null; failureCode = 'READONLY_RELAY_EXPIRED'; }
    if (!sourceUnchanged) { report = null; failureCode = 'READONLY_RELAY_SOURCE_CHANGED'; }
    if (!cleanupConfirmed) { report = null; failureCode = 'READONLY_RELAY_RECOVERY_UNCERTAIN'; }
    return this.store.finish(request.investigationId, attempt.generation, report, report ? null : (failureCode ?? 'READONLY_RELAY_CALL_FAILED'), finish);
  }

  cancel(id: string, context: ReadonlyContext): ReadonlyRelaySnapshot { return this.store.cancel(id, context); }
  invalidate(id: string, context: ReadonlyContext): ReadonlyRelaySnapshot { return this.store.invalidate(id, context); }
  async recover(id: string, context: ReadonlyContext): Promise<ReadonlyRelaySnapshot> {
    const snapshot = this.store.inspect(id, currentContext(context));
    let confirmed = false;
    const cancelledDispatch = snapshot.task.status === 'CANCELLED' && snapshot.attempt !== null && snapshot.attempt.dispatchedAt !== null;
    if ((snapshot.task.status === 'RUNNING' || cancelledDispatch) && snapshot.payload) {
      try {
        await assertReadonlyRepository(snapshot.payload.repository);
        confirmed = this.cleanupVerifier?.(id, hashes(snapshot.task.plan)) === true;
      } catch { /* 원본 또는 프로세스 정리 증거가 불확실하면 차단한다. */ }
    }
    return this.store.recover(id, currentContext(context), confirmed);
  }
  prune(context: ReadonlyContext): ReadonlyRelayPruneResult { return this.store.prune(context); }

  private requireConfig(enabled: boolean): ReadonlyRelayConfig {
    const config = parseReadonlyRelayConfig(this.config);
    if (enabled && !config.enabled) throw new HarnessError('READONLY_RELAY_DISABLED');
    return config;
  }
  private assertPort(): void {
    if (!this.port || this.port.mode !== 'live' || this.port.transport !== 'codex-cli-relay' || typeof this.port.transmit !== 'function'
      || (this.port.verifyReady !== undefined && typeof this.port.verifyReady !== 'function')) throw new HarnessError('READONLY_RELAY_INVALID_PORT');
  }
}
