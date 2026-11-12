import { randomUUID } from 'node:crypto';
import type { ReadonlyContext, ReadonlySelection } from '../domain/readonly-investigation.js';
import { HarnessError } from '../domain/errors.js';
import type {
  ReadonlyApproval, ReadonlyApprovalRequest, ReadonlyInvestigationStore, ReadonlyModelPort,
  ReadonlyPruneResult, ReadonlyReport, ReadonlyRunRequest, ReadonlySnapshot,
} from '../ports/readonly-investigation.js';
import {
  assertReadonlyContext, createReadonlyPlan, defaultReadonlySelection, isReadonlyId, parseReadonlyResult, readonlyExactKeys, selectReadonlyTransfer, validateReadonlyPayload,
} from '../policy/readonly-investigation-policy.js';
import { assertReadonlyRepository, collectReadonlyPayload, prepareReadonlyRepository } from '../adapters/readonly-repository.js';

const currentContext = (context: ReadonlyContext): ReadonlyContext => ({
  ownerId: context.ownerId, now: new Date(Math.max(Date.now(), context.now.getTime())),
});
const safeFailure = (error: unknown): string => {
  const allowed = ['READONLY_INVALID_RESPONSE', 'READONLY_OUTPUT_LIMIT', 'READONLY_TIMEOUT', 'READONLY_EXPIRED', 'READONLY_SOURCE_CHANGED'];
  return error instanceof HarnessError && allowed.includes(error.code) ? error.code : 'READONLY_CALL_FAILED';
};

/** 읽기와 전송을 별도로 승인하고 결과를 로컬에만 보관한다. 실행·내보내기 포트는 없다. */
export class ReadonlyInvestigationService {
  constructor(
    private readonly store: ReadonlyInvestigationStore,
    private readonly port: ReadonlyModelPort,
    private readonly dataDirectory: string,
    private readonly cleanupVerifier?: (id: string, inputHash: string) => boolean,
  ) {
    if (port.mode !== 'mock') throw new HarnessError('READONLY_LIVE_DISABLED');
  }

  async plan(fixtureId: string, selection: ReadonlySelection | undefined, context: ReadonlyContext, transferPreset: 'all' | 'controller' | 'service' = 'all'): Promise<ReadonlySnapshot> {
    assertReadonlyContext(context);
    this.store.prune(context);
    if (fixtureId !== 'flow') throw new HarnessError('READONLY_INVALID_FIXTURE');
    if (!['all', 'controller', 'service'].includes(transferPreset)) throw new HarnessError('READONLY_INVALID_SELECTION');
    const id = randomUUID();
    const repository = await prepareReadonlyRepository(this.dataDirectory, id, fixtureId);
    let payload = await collectReadonlyPayload(repository, selection ?? defaultReadonlySelection(), context);
    if (transferPreset !== 'all') {
      payload = selectReadonlyTransfer(payload, payload.context.evidence.filter((item) => item.path === `src/${transferPreset}.ts`).map((item) => item.evidenceId));
    }
    const plan = createReadonlyPlan(payload, context, id);
    await assertReadonlyRepository(repository);
    return this.store.create(plan, payload, context);
  }

  inspect(id: string, context: ReadonlyContext, offset = 0): ReadonlySnapshot { return this.store.inspect(id, context, offset); }

  approve(request: ReadonlyApprovalRequest, context: ReadonlyContext): ReadonlyApproval {
    if (this.port.mode !== 'mock') throw new HarnessError('READONLY_LIVE_DISABLED');
    if (!readonlyExactKeys(request, ['investigationId', 'planHash', 'expiresInMinutes']) || !isReadonlyId(request.investigationId)) throw new HarnessError('READONLY_INVALID_APPROVAL');
    const snapshot = this.store.inspect(request.investigationId, context);
    if (!snapshot.payload) throw new HarnessError('READONLY_PAYLOAD_UNAVAILABLE');
    validateReadonlyPayload(snapshot.task.plan, snapshot.payload);
    return this.store.approve(request, context);
  }

  async run(request: ReadonlyRunRequest, context: ReadonlyContext, signal?: AbortSignal): Promise<ReadonlySnapshot> {
    assertReadonlyContext(context);
    if (!readonlyExactKeys(request, ['investigationId', 'planHash']) || !isReadonlyId(request.investigationId)) throw new HarnessError('READONLY_INVALID_RUN');
    if (this.port.mode !== 'mock') throw new HarnessError('READONLY_LIVE_DISABLED');
    let snapshot = this.store.inspect(request.investigationId, currentContext(context));
    if (!snapshot.payload) throw new HarnessError('READONLY_PAYLOAD_UNAVAILABLE');
    validateReadonlyPayload(snapshot.task.plan, snapshot.payload);
    await assertReadonlyRepository(snapshot.payload.repository);
    if (signal?.aborted) return this.store.cancel(request.investigationId, currentContext(context));
    // 길어진 원본 확인 뒤 저장된 승인·입력을 다시 검사한다. 계획 snapshot을 재수집으로 대체하지 않는다.
    snapshot = this.store.inspect(request.investigationId, currentContext(context));
    if (!snapshot.payload) throw new HarnessError('READONLY_PAYLOAD_UNAVAILABLE');
    validateReadonlyPayload(snapshot.task.plan, snapshot.payload);
    const payload = snapshot.payload;
    const plan = snapshot.task.plan;
    const attempt = this.store.claim(request, currentContext(context));
    const controller = new AbortController();
    let timedOut = false;
    let monitoringFailure = false;
    let rejectAbort: (error: HarnessError) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    void aborted.catch(() => {});
    const abort = (): void => { controller.abort(); rejectAbort(new HarnessError(timedOut ? 'READONLY_TIMEOUT' : 'READONLY_CANCELLED')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => { timedOut = true; abort(); }, plan.limits.timeoutSeconds * 1000);
    const monitor = setInterval(() => {
      try { this.store.assertRunnable(request.investigationId, attempt.generation, currentContext(context)); }
      catch { monitoringFailure = true; abort(); }
    }, 25);
    let modelCall: Promise<string> | null = null;
    let report: ReadonlyReport | null = null;
    let failureCode: string | null = null;
    try {
      await assertReadonlyRepository(payload.repository);
      this.store.assertRunnable(request.investigationId, attempt.generation, currentContext(context));
      if (controller.signal.aborted) throw new HarnessError('READONLY_CANCELLED');
      const raw = await Promise.race([
        this.store.dispatch(request.investigationId, attempt.generation, currentContext(context), (inputText) => {
          if (this.port.mode !== 'mock' || controller.signal.aborted) throw new HarnessError('READONLY_CANCELLED');
          modelCall = this.port.investigate(inputText, controller.signal);
          return modelCall;
        }), aborted,
      ]);
      const parsed = parseReadonlyResult(raw, payload);
      const { mode, responseHash, ...result } = parsed;
      report = { mode, investigationId: request.investigationId, planHash: plan.planHash, contextHash: plan.contextHash,
        inputHash: plan.inputHash, responseHash, result, createdAt: currentContext(context).now.toISOString(),
        targetUnchanged: true, executionAllowed: false, semanticAccuracyVerified: false,
        checks: { sourceUnchanged: 'passed', targetCodeExecution: 'not_run', realModel: 'not_run', externalTransmission: 'not_run' } };
    } catch (error) {
      failureCode = safeFailure(error);
    } finally {
      clearInterval(monitor);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    // 실패·취소도 원본 확인을 생략하지 않는다. 원본 경합의 결과를 성공 보고로 바꾸지 않는다.
    try { await assertReadonlyRepository(payload.repository); }
    catch { report = null; failureCode = 'READONLY_SOURCE_CHANGED'; }
    let cleanupConfirmed = true;
    if (controller.signal.aborted && modelCall !== null) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      cleanupConfirmed = await Promise.race([
        (modelCall as Promise<string>).then(() => true, () => true),
        new Promise<boolean>((resolve) => { cleanupTimer = setTimeout(() => resolve(false), 1000); }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (this.cleanupVerifier) {
        try { cleanupConfirmed = this.cleanupVerifier(request.investigationId, plan.inputHash); } catch { cleanupConfirmed = false; }
      }
    }
    const finish = currentContext(context);
    if (signal?.aborted || (controller.signal.aborted && !timedOut && !monitoringFailure)) this.store.cancel(request.investigationId, finish);
    if (timedOut) { report = null; failureCode = 'READONLY_TIMEOUT'; }
    if (monitoringFailure) { report = null; failureCode = 'READONLY_EXPIRED'; }
    if (!cleanupConfirmed) { report = null; failureCode = 'READONLY_RECOVERY_UNCERTAIN'; }
    // 취소된 generation은 store가 terminal 기록을 그대로 반환하며 늦은 본문을 저장하지 않는다.
    return this.store.finish(request.investigationId, attempt.generation, report, report ? null : (failureCode ?? 'READONLY_CALL_FAILED'), finish);
  }

  cancel(id: string, context: ReadonlyContext): ReadonlySnapshot { return this.store.cancel(id, context); }
  invalidate(id: string, context: ReadonlyContext): ReadonlySnapshot { return this.store.invalidate(id, context); }
  async recover(id: string, context: ReadonlyContext): Promise<ReadonlySnapshot> {
    const snapshot = this.store.inspect(id, currentContext(context));
    let confirmed = false;
    if (snapshot.task.status === 'RUNNING' && snapshot.payload) {
      try {
        await assertReadonlyRepository(snapshot.payload.repository);
        confirmed = this.cleanupVerifier?.(id, snapshot.task.plan.inputHash) === true;
      } catch { /* 원본 또는 정리가 불확실하면 차단 상태로 남긴다. */ }
    }
    return this.store.recover(id, currentContext(context), confirmed);
  }
  prune(context: ReadonlyContext): ReadonlyPruneResult { return this.store.prune(context); }
}
