import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { PersonalReadonlyRegistration, PersonalReadonlyPlan } from '../domain/personal-readonly.js';
import { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS, type ReadonlyRelayConfig } from '../domain/readonly-relay.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../ports/readonly-relay.js';
import type {
  PersonalReadonlyApproval, PersonalReadonlyApprovalRequest, PersonalReadonlyPruneResult,
  PersonalReadonlyReport, PersonalReadonlyRunRequest, PersonalReadonlySnapshot, PersonalReadonlyStore,
} from '../ports/personal-readonly.js';
import { assertReadonlyContext, hashReadonlyValue, isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import {
  assertPersonalReadonlyDispatch, createPersonalReadonlyPayload, createPersonalReadonlyPlan, parsePersonalReadonlyRegistration,
  parsePersonalReadonlyResult, validatePersonalReadonlyPayload,
} from '../policy/personal-readonly-policy.js';
import { assertPersonalReadonlyRepository, assertPersonalReadonlyRepositoryNow, collectPersonalReadonlyEvidence, inspectPersonalReadonlyRepository } from '../adapters/personal-readonly-repository.js';
import { parseReadonlyRelayConfig } from '../policy/readonly-relay-policy.js';

type CleanupHashes = Pick<PersonalReadonlyPlan, 'requestBodyHash' | 'requestEnvelopeHash' | 'connectionProfileHash'>;
const hashes = (plan: PersonalReadonlyPlan): CleanupHashes => ({ requestBodyHash: plan.requestBodyHash,
  requestEnvelopeHash: plan.requestEnvelopeHash, connectionProfileHash: plan.connectionProfileHash });
const currentContext = (context: ReadonlyContext): ReadonlyContext => ({ ownerId: context.ownerId, now: new Date(Math.max(Date.now(), context.now.getTime())) });
const safeFailure = (error: unknown): string => {
  if (!(error instanceof HarnessError)) return 'PERSONAL_READONLY_CALL_FAILED';
  if (['READONLY_RELAY_LIFECYCLE_UNSAFE', 'PERSONAL_READONLY_LIFECYCLE_UNSAFE'].includes(error.code)) return 'PERSONAL_READONLY_RECOVERY_UNCERTAIN';
  const allowed = ['INVALID_RESPONSE', 'OUTPUT_LIMIT', 'TIMEOUT', 'EXPIRED', 'SOURCE_CHANGED'];
  const suffix = allowed.find((item) => error.code === `READONLY_RELAY_${item}` || error.code === `PERSONAL_READONLY_${item}`);
  return suffix ? `PERSONAL_READONLY_${suffix}` : 'PERSONAL_READONLY_CALL_FAILED';
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
    throw new HarnessError('PERSONAL_READONLY_INVALID_RESPONSE');
  }
  if (Buffer.byteLength(raw.text) > 16 * 1024) throw new HarnessError('PERSONAL_READONLY_OUTPUT_LIMIT');
};

/** 등록된 개인 저장소의 승인된 근거만 한 번 전송하고 실행 없이 결과를 보관한다. */
export class PersonalReadonlyService {
  constructor(
    private readonly store: PersonalReadonlyStore,
    private readonly port: ReadonlyRelayPort,
    private readonly dataDirectory: string,
    private readonly config?: ReadonlyRelayConfig,
    private readonly cleanupVerifier?: (id: string, hashes: CleanupHashes) => boolean,
  ) { this.assertPort(); }

  async plan(registration: PersonalReadonlyRegistration, context: ReadonlyContext): Promise<PersonalReadonlySnapshot> {
    assertReadonlyContext(context);
    const config = this.requireConfig(false);
    const registered = parsePersonalReadonlyRegistration(registration);
    this.assertDataDirectory(registered);
    this.store.prune(context);
    const repository = await inspectPersonalReadonlyRepository(registered, randomUUID());
    const evidence = await collectPersonalReadonlyEvidence(repository, registered);
    const payload = createPersonalReadonlyPayload(repository, registered, evidence, context, config);
    const plan = createPersonalReadonlyPlan(payload, context, config);
    await assertPersonalReadonlyRepository(repository);
    return this.store.create(plan, payload, context);
  }

  inspect(id: string, context: ReadonlyContext, offset = 0): PersonalReadonlySnapshot { return this.store.inspect(id, context, offset); }

  approve(request: PersonalReadonlyApprovalRequest, context: ReadonlyContext): PersonalReadonlyApproval {
    this.assertPort();
    const config = this.requireConfig(true);
    if (!readonlyExactKeys(request, ['investigationId', 'planHash', 'expiresInMinutes']) || !isReadonlyId(request.investigationId)) throw new HarnessError('PERSONAL_READONLY_INVALID_APPROVAL');
    const snapshot = this.store.inspect(request.investigationId, context);
    if (!snapshot.payload) throw new HarnessError('PERSONAL_READONLY_PAYLOAD_UNAVAILABLE');
    validatePersonalReadonlyPayload(snapshot.task.plan, snapshot.payload, config);
    try { assertPersonalReadonlyRepositoryNow(snapshot.payload.repository); }
    catch { throw new HarnessError('PERSONAL_READONLY_SOURCE_CHANGED'); }
    return this.store.approve(request, context);
  }

  async run(request: PersonalReadonlyRunRequest, context: ReadonlyContext, signal?: AbortSignal): Promise<PersonalReadonlySnapshot> {
    assertReadonlyContext(context);
    this.assertPort();
    const config = this.requireConfig(true);
    if (!readonlyExactKeys(request, ['investigationId', 'planHash']) || !isReadonlyId(request.investigationId)) throw new HarnessError('PERSONAL_READONLY_INVALID_RUN');
    let snapshot = this.store.inspect(request.investigationId, currentContext(context));
    if (!snapshot.payload) throw new HarnessError('PERSONAL_READONLY_PAYLOAD_UNAVAILABLE');
    validatePersonalReadonlyPayload(snapshot.task.plan, snapshot.payload, config);
    if (snapshot.task.status !== 'APPROVED' || !snapshot.approvals.some((approval) => approval.usedAt === null && approval.revokedAt === null)) {
      throw new HarnessError('PERSONAL_READONLY_APPROVAL_REQUIRED');
    }
    await assertPersonalReadonlyRepository(snapshot.payload.repository);
    if (signal?.aborted) return this.store.cancel(request.investigationId, currentContext(context));
    // 설치 파일 부재는 승인을 소비하지 않는다. 비동기 준비 뒤 승인·시간·취소를 다시 검사한다.
    await this.port.verifyReady?.();
    if (signal?.aborted) return this.store.cancel(request.investigationId, currentContext(context));
    this.assertPort();
    snapshot = this.store.inspect(request.investigationId, currentContext(context));
    if (!snapshot.payload) throw new HarnessError('PERSONAL_READONLY_PAYLOAD_UNAVAILABLE');
    validatePersonalReadonlyPayload(snapshot.task.plan, snapshot.payload, config);
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
    let report: PersonalReadonlyReport | null = null;
    let failureCode: string | null = null;
    let cleanupConfirmed = true;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assertPersonalReadonlyRepository(payload.repository);
      let transmissionChecks = 0;
      const assertCurrent = (): void => {
        this.assertPort();
        if (controller.signal.aborted) throw new HarnessError('PERSONAL_READONLY_CANCELLED');
        this.store.assertRunnable(request.investigationId, attempt.generation, currentContext(context));
      };
      const beforeCredentialAccess = (): void => {
        try { assertPersonalReadonlyRepositoryNow(payload.repository); }
        catch { throw new HarnessError('PERSONAL_READONLY_SOURCE_CHANGED'); }
        assertCurrent();
      };
      const beforeTransmission = (): void => {
        if (++transmissionChecks !== 1) throw new HarnessError('PERSONAL_READONLY_ALREADY_DISPATCHED');
        beforeCredentialAccess();
      };
      assertCurrent();
      const call = this.store.dispatch(request.investigationId, attempt.generation, currentContext(context), (dispatch) => {
        assertPersonalReadonlyDispatch(dispatch, config);
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
        cleanupConfirmed = cleanup.kind !== 'uncertain' && !(cleanup.kind === 'error' && safeFailure(cleanup.error) === 'PERSONAL_READONLY_RECOVERY_UNCERTAIN');
        throw new HarnessError(timedOut ? 'PERSONAL_READONLY_TIMEOUT' : 'PERSONAL_READONLY_CANCELLED');
      }
      if (outcome.kind === 'error') throw outcome.error;
      const raw = outcome.value;
      if (transmissionChecks !== 1) throw new HarnessError('PERSONAL_READONLY_INVALID_RESPONSE');
      assertResponse(raw);
      const { mode, transport, responseOrigin, classification, summary, facts, hypotheses, answerDraft, questions, suggestions, limitations } = parsePersonalReadonlyResult(raw.text, payload);
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
      if (failureCode === 'PERSONAL_READONLY_RECOVERY_UNCERTAIN') cleanupConfirmed = false;
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
    try { await assertPersonalReadonlyRepository(payload.repository); }
    catch { sourceUnchanged = false; }
    const finish = currentContext(context);
    if (signal?.aborted) this.store.cancel(request.investigationId, finish);
    if (timedOut) { report = null; failureCode = 'PERSONAL_READONLY_TIMEOUT'; }
    if (monitoringFailure) { report = null; failureCode = 'PERSONAL_READONLY_EXPIRED'; }
    if (!sourceUnchanged) { report = null; failureCode = 'PERSONAL_READONLY_SOURCE_CHANGED'; }
    if (!cleanupConfirmed) { report = null; failureCode = 'PERSONAL_READONLY_RECOVERY_UNCERTAIN'; }
    return this.store.finish(request.investigationId, attempt.generation, report, report ? null : (failureCode ?? 'PERSONAL_READONLY_CALL_FAILED'), finish);
  }

  cancel(id: string, context: ReadonlyContext): PersonalReadonlySnapshot { return this.store.cancel(id, context); }
  invalidate(id: string, context: ReadonlyContext): PersonalReadonlySnapshot { return this.store.invalidate(id, context); }
  async recover(id: string, context: ReadonlyContext): Promise<PersonalReadonlySnapshot> {
    const snapshot = this.store.inspect(id, currentContext(context));
    let confirmed = false;
    const cancelledDispatch = snapshot.task.status === 'CANCELLED' && snapshot.attempt !== null && snapshot.attempt.dispatchedAt !== null;
    if ((snapshot.task.status === 'RUNNING' || cancelledDispatch) && snapshot.payload) {
      try {
        await assertPersonalReadonlyRepository(snapshot.payload.repository);
        confirmed = this.cleanupVerifier?.(id, hashes(snapshot.task.plan)) === true;
      } catch { /* 원본 또는 프로세스 정리 증거가 불확실하면 차단한다. */ }
    }
    return this.store.recover(id, currentContext(context), confirmed);
  }
  prune(context: ReadonlyContext): PersonalReadonlyPruneResult { return this.store.prune(context); }

  private assertDataDirectory(registration: PersonalReadonlyRegistration): void {
    let sourceRoot: string; let dataDirectory: string;
    try { sourceRoot = realpathSync(registration.sourceRoot); dataDirectory = realpathSync(this.dataDirectory); }
    catch { throw new HarnessError('PERSONAL_READONLY_UNSAFE_DATA_DIRECTORY'); }
    const contains = (parent: string, child: string): boolean => {
      const path = relative(parent, child);
      return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
    };
    if (contains(sourceRoot, dataDirectory) || contains(dataDirectory, sourceRoot)) throw new HarnessError('PERSONAL_READONLY_UNSAFE_DATA_DIRECTORY');
  }
  private requireConfig(enabled: boolean): ReadonlyRelayConfig {
    const config = parseReadonlyRelayConfig(this.config);
    if (enabled && !config.enabled) throw new HarnessError('PERSONAL_READONLY_DISABLED');
    return config;
  }
  private assertPort(): void {
    if (!this.port || this.port.mode !== 'live' || this.port.transport !== 'codex-cli-relay' || typeof this.port.transmit !== 'function'
      || (this.port.verifyReady !== undefined && typeof this.port.verifyReady !== 'function')) throw new HarnessError('PERSONAL_READONLY_INVALID_PORT');
  }
}
