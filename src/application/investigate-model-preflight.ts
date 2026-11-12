import { randomUUID } from 'node:crypto';
import type { ReadonlyContext, ReadonlySelection } from '../domain/readonly-investigation.js';
import { HarnessError } from '../domain/errors.js';
import type {
  ReadonlyModelPreflightApproval, ReadonlyModelPreflightApprovalRequest, ReadonlyModelPreflightStore, ReadonlyModelPreflightPort,
  ReadonlyModelPreflightPruneResult, ReadonlyModelPreflightReport, ReadonlyModelPreflightRunRequest, ReadonlyModelPreflightSnapshot,
} from '../ports/readonly-model-preflight.js';
import {
  assertReadonlyContext, defaultReadonlySelection, isReadonlyId, readonlyExactKeys, selectReadonlyTransfer,
} from '../policy/readonly-investigation-policy.js';
import type { ReadonlyModelPreflightProfileId, ReadonlyModelPreflightDecodedResponse, ReadonlyModelPreflightPlan } from '../domain/readonly-model-preflight.js';
import { createReadonlyModelPreflightPayload, createReadonlyModelPreflightPlan, parseReadonlyModelPreflightResult, validateReadonlyModelPreflightPayload } from '../policy/readonly-model-preflight-policy.js';
import { ReadonlyModelPreflightBroker } from '../adapters/readonly-model-preflight-broker.js';
import { assertReadonlyRepository, collectReadonlyPayload, prepareReadonlyRepository } from '../adapters/readonly-repository.js';

const currentContext = (context: ReadonlyContext): ReadonlyContext => ({
  ownerId: context.ownerId, now: new Date(Math.max(Date.now(), context.now.getTime())),
});
const safeFailure = (error: unknown): string => {
  if (error instanceof HarnessError && error.code === 'READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE') return 'READONLY_MODEL_PREFLIGHT_RECOVERY_UNCERTAIN';
  const allowed = ['READONLY_MODEL_PREFLIGHT_INVALID_RESPONSE', 'READONLY_MODEL_PREFLIGHT_OUTPUT_LIMIT', 'READONLY_MODEL_PREFLIGHT_TIMEOUT', 'READONLY_MODEL_PREFLIGHT_EXPIRED', 'READONLY_MODEL_PREFLIGHT_SOURCE_CHANGED'];
  return error instanceof HarnessError && allowed.includes(error.code) ? error.code : 'READONLY_MODEL_PREFLIGHT_CALL_FAILED';
};

/** 읽기와 전송을 별도로 승인하고 결과를 로컬에만 보관한다. 실행·내보내기 포트는 없다. */
export class ReadonlyModelPreflightService {
  constructor(
    private readonly store: ReadonlyModelPreflightStore,
    private readonly port: ReadonlyModelPreflightPort,
    private readonly dataDirectory: string,
    private readonly cleanupVerifier?: (id: string, hashes: Pick<ReadonlyModelPreflightPlan, 'requestBodyHash' | 'requestEnvelopeHash' | 'connectionProfileHash'>) => boolean,
  ) {
    if (!port || port.mode !== 'offline' || port.transport !== 'in-memory-fake' || typeof port.transmit !== 'function') throw new HarnessError('READONLY_MODEL_PREFLIGHT_LIVE_DISABLED');
  }

  async plan(fixtureId: string, selection: ReadonlySelection | undefined, context: ReadonlyContext, transferPreset: 'all' | 'controller' | 'service' = 'all', profileId: ReadonlyModelPreflightProfileId = 'responses-candidate-json-v1'): Promise<ReadonlyModelPreflightSnapshot> {
    assertReadonlyContext(context);
    this.store.prune(context);
    if (fixtureId !== 'flow') throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_FIXTURE');
    if (!['responses-candidate-json-v1', 'responses-candidate-sse-v1'].includes(profileId)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_PROFILE');
    if (!['all', 'controller', 'service'].includes(transferPreset)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_SELECTION');
    const id = randomUUID();
    const repository = await prepareReadonlyRepository(this.dataDirectory, id, fixtureId);
    let payload = await collectReadonlyPayload(repository, selection ?? defaultReadonlySelection(), context);
    if (transferPreset !== 'all') {
      payload = selectReadonlyTransfer(payload, payload.context.evidence.filter((item) => item.path === `src/${transferPreset}.ts`).map((item) => item.evidenceId));
    }
    const transportPayload = createReadonlyModelPreflightPayload(payload, profileId);
    const plan = createReadonlyModelPreflightPlan(transportPayload, context);
    await assertReadonlyRepository(repository);
    return this.store.create(plan, transportPayload, context);
  }

  inspect(id: string, context: ReadonlyContext, offset = 0): ReadonlyModelPreflightSnapshot { return this.store.inspect(id, context, offset); }

  approve(request: ReadonlyModelPreflightApprovalRequest, context: ReadonlyContext): ReadonlyModelPreflightApproval {
    if (this.port.mode !== 'offline' || this.port.transport !== 'in-memory-fake' || typeof this.port.transmit !== 'function') throw new HarnessError('READONLY_MODEL_PREFLIGHT_LIVE_DISABLED');
    if (!readonlyExactKeys(request, ['investigationId', 'planHash', 'expiresInMinutes']) || !isReadonlyId(request.investigationId)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_APPROVAL');
    const snapshot = this.store.inspect(request.investigationId, context);
    if (!snapshot.payload) throw new HarnessError('READONLY_MODEL_PREFLIGHT_PAYLOAD_UNAVAILABLE');
    validateReadonlyModelPreflightPayload(snapshot.task.plan, snapshot.payload);
    return this.store.approve(request, context);
  }

  async run(request: ReadonlyModelPreflightRunRequest, context: ReadonlyContext, signal?: AbortSignal): Promise<ReadonlyModelPreflightSnapshot> {
    assertReadonlyContext(context);
    if (!readonlyExactKeys(request, ['investigationId', 'planHash']) || !isReadonlyId(request.investigationId)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_RUN');
    if (this.port.mode !== 'offline' || this.port.transport !== 'in-memory-fake' || typeof this.port.transmit !== 'function') throw new HarnessError('READONLY_MODEL_PREFLIGHT_LIVE_DISABLED');
    let snapshot = this.store.inspect(request.investigationId, currentContext(context));
    if (!snapshot.payload) throw new HarnessError('READONLY_MODEL_PREFLIGHT_PAYLOAD_UNAVAILABLE');
    validateReadonlyModelPreflightPayload(snapshot.task.plan, snapshot.payload);
    await assertReadonlyRepository(snapshot.payload.repository);
    if (signal?.aborted) return this.store.cancel(request.investigationId, currentContext(context));
    // 길어진 원본 확인 뒤 저장된 승인·입력을 다시 검사한다. 계획 snapshot을 재수집으로 대체하지 않는다.
    snapshot = this.store.inspect(request.investigationId, currentContext(context));
    if (!snapshot.payload) throw new HarnessError('READONLY_MODEL_PREFLIGHT_PAYLOAD_UNAVAILABLE');
    validateReadonlyModelPreflightPayload(snapshot.task.plan, snapshot.payload);
    const payload = snapshot.payload;
    const plan = snapshot.task.plan;
    const broker = new ReadonlyModelPreflightBroker(this.port);
    const attempt = this.store.claim(request, currentContext(context));
    const controller = new AbortController();
    let timedOut = false;
    let monitoringFailure = false;
    let rejectAbort: (error: HarnessError) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    void aborted.catch(() => {});
    const abort = (): void => { controller.abort(); rejectAbort(new HarnessError(timedOut ? 'READONLY_MODEL_PREFLIGHT_TIMEOUT' : 'READONLY_MODEL_PREFLIGHT_CANCELLED')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => { timedOut = true; abort(); }, plan.limits.responseTimeoutMs);
    const monitor = setInterval(() => {
      try { this.store.assertRunnable(request.investigationId, attempt.generation, currentContext(context)); }
      catch { monitoringFailure = true; abort(); }
    }, 25);
    let transportCall: Promise<ReadonlyModelPreflightDecodedResponse> | null = null;
    let report: ReadonlyModelPreflightReport | null = null;
    let failureCode: string | null = null;
    try {
      await assertReadonlyRepository(payload.repository);
      this.store.assertRunnable(request.investigationId, attempt.generation, currentContext(context));
      if (controller.signal.aborted) throw new HarnessError('READONLY_MODEL_PREFLIGHT_CANCELLED');
      const raw = await Promise.race([
        this.store.dispatch(request.investigationId, attempt.generation, currentContext(context), (dispatch) => {
          if (this.port.mode !== 'offline' || this.port.transport !== 'in-memory-fake' || controller.signal.aborted) throw new HarnessError('READONLY_MODEL_PREFLIGHT_CANCELLED');
          const transmission: Promise<ReadonlyModelPreflightDecodedResponse> = broker.transmit(dispatch, controller.signal);
          transportCall = transmission;
          return transmission;
        }), aborted,
      ]);
      const parsed = parseReadonlyModelPreflightResult(raw.text, payload);
      const { mode, transport, responseOrigin, classification, summary, facts, hypotheses, answerDraft, questions, suggestions, limitations } = parsed;
      const result = { classification, summary, facts, hypotheses, answerDraft, questions, suggestions, limitations };
      if (!/^[a-f0-9]{64}$/.test(raw.responseHash)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_RESPONSE');
      report = { mode, transport, responseOrigin, investigationId: request.investigationId, planHash: plan.planHash, contextHash: plan.contextHash,
        inputHash: plan.inputHash, requestBodyHash: plan.requestBodyHash, connectionProfileHash: plan.connectionProfileHash, requestEnvelopeHash: plan.requestEnvelopeHash, responseHash: raw.responseHash, result, createdAt: currentContext(context).now.toISOString(),
        targetUnchanged: true, executionAllowed: false, semanticAccuracyVerified: false, liveReady: false,
        offlineContractVerified: { profile: 'passed', envelope: 'passed', response: 'passed', evidence: 'passed' }, excludedOperationsReason: 'offline-fake-only',
        checks: { sourceUnchanged: 'passed', targetCodeExecution: 'not_run', realModel: 'not_run', externalTransmission: 'not_run', credentialAccess: 'not_run', providerCompatibility: 'not_run', liveIsolation: 'not_run', semanticAccuracy: 'not_run' } };
    } catch (error) {
      failureCode = safeFailure(error);
    } finally {
      clearInterval(monitor);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    // 실패·취소도 원본 확인을 생략하지 않는다. 원본 경합의 결과를 성공 보고로 바꾸지 않는다.
    let sourceUnchanged = true;
    try { await assertReadonlyRepository(payload.repository); }
    catch { sourceUnchanged = false; report = null; failureCode = 'READONLY_MODEL_PREFLIGHT_SOURCE_CHANGED'; }
    let cleanupConfirmed = true;
    if (controller.signal.aborted && transportCall !== null) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      cleanupConfirmed = await Promise.race([
        (transportCall as Promise<ReadonlyModelPreflightDecodedResponse>).then(() => true,
          (error: unknown) => !(error instanceof HarnessError && error.code === 'READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE')),
        new Promise<boolean>((resolve) => { cleanupTimer = setTimeout(() => resolve(false), plan.limits.cleanupTimeoutMs); }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (this.cleanupVerifier) {
        try { cleanupConfirmed = cleanupConfirmed && this.cleanupVerifier(request.investigationId, { requestBodyHash: plan.requestBodyHash, requestEnvelopeHash: plan.requestEnvelopeHash, connectionProfileHash: plan.connectionProfileHash }); } catch { cleanupConfirmed = false; }
      }
    }
    const finish = currentContext(context);
    if (signal?.aborted || (controller.signal.aborted && !timedOut && !monitoringFailure)) this.store.cancel(request.investigationId, finish);
    if (timedOut) { report = null; failureCode = 'READONLY_MODEL_PREFLIGHT_TIMEOUT'; }
    if (monitoringFailure) { report = null; failureCode = 'READONLY_MODEL_PREFLIGHT_EXPIRED'; }
    if (!sourceUnchanged) { report = null; failureCode = 'READONLY_MODEL_PREFLIGHT_SOURCE_CHANGED'; }
    if (!cleanupConfirmed) { report = null; failureCode = 'READONLY_MODEL_PREFLIGHT_RECOVERY_UNCERTAIN'; }
    // 취소된 generation은 store가 terminal 기록을 그대로 반환하며 늦은 본문을 저장하지 않는다.
    return this.store.finish(request.investigationId, attempt.generation, report, report ? null : (failureCode ?? 'READONLY_MODEL_PREFLIGHT_CALL_FAILED'), finish);
  }

  cancel(id: string, context: ReadonlyContext): ReadonlyModelPreflightSnapshot { return this.store.cancel(id, context); }
  invalidate(id: string, context: ReadonlyContext): ReadonlyModelPreflightSnapshot { return this.store.invalidate(id, context); }
  async recover(id: string, context: ReadonlyContext): Promise<ReadonlyModelPreflightSnapshot> {
    const snapshot = this.store.inspect(id, currentContext(context));
    let confirmed = false;
    if (snapshot.task.status === 'RUNNING' && snapshot.payload) {
      try {
        await assertReadonlyRepository(snapshot.payload.repository);
        confirmed = this.cleanupVerifier?.(id, { requestBodyHash: snapshot.task.plan.requestBodyHash, requestEnvelopeHash: snapshot.task.plan.requestEnvelopeHash, connectionProfileHash: snapshot.task.plan.connectionProfileHash }) === true;
      } catch { /* 원본 또는 정리가 불확실하면 차단 상태로 남긴다. */ }
    }
    return this.store.recover(id, currentContext(context), confirmed);
  }
  prune(context: ReadonlyContext): ReadonlyModelPreflightPruneResult { return this.store.prune(context); }
}
