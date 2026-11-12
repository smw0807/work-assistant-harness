import type { BranchWorkType } from '../domain/branch.js';
import type {
  CodexProposalApproval, CodexProposalApprovalRequest, CodexProposalContext, CodexProposalExport,
  CodexProposalResult, CodexProposalSnapshot, CodexProposalTask,
} from '../domain/codex-proposal.js';
import { HarnessError } from '../domain/errors.js';
import type { CodexProposalPort, CodexProposalStore } from '../ports/codex-proposal.js';
import {
  createCodexProposalPlan, getCodexProposalInput, isCodexProposalHash, parseCodexProposalResponse,
} from '../policy/codex-proposal-policy.js';

const currentContext = (context: CodexProposalContext): CodexProposalContext => ({
  ownerId: context.ownerId, now: new Date(Math.max(Date.now(), context.now.getTime())),
});

/** 모델 호출 승인만 소비한다. 결과를 실행하는 권한은 별도 실행 계획에서 다시 받아야 한다. */
export class CodexProposalService {
  constructor(private readonly store: CodexProposalStore, private readonly port: CodexProposalPort, private readonly configHash: string) {
    if (!isCodexProposalHash(configHash)) throw new HarnessError('CODEX_PROPOSAL_CONFIG_MISMATCH');
  }

  plan(workType: BranchWorkType, context: CodexProposalContext, proposalId?: string): CodexProposalTask {
    return this.store.create(createCodexProposalPlan(workType, this.configHash, context, proposalId), context);
  }

  inspect(proposalId: string, context: CodexProposalContext, offset = 0): CodexProposalSnapshot {
    return this.store.inspect(proposalId, context, offset);
  }

  approve(request: CodexProposalApprovalRequest, context: CodexProposalContext): CodexProposalApproval {
    this.assertConfig(this.store.inspect(request.proposalId, context).task);
    return this.store.approve(request, context);
  }

  async run(proposalId: string, planHash: string, context: CodexProposalContext, signal?: AbortSignal): Promise<CodexProposalSnapshot> {
    const start = currentContext(context);
    this.assertConfig(this.store.inspect(proposalId, start).task);
    if (signal?.aborted) return this.store.cancel(proposalId, start);
    const attempt = this.store.claim(proposalId, planHash, start);
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const monitor = setInterval(() => {
      try { this.store.assertRunnable(proposalId, attempt.generation, currentContext(context)); }
      catch { controller.abort(); }
    }, 25);
    monitor.unref();
    let result: CodexProposalResult | null = null;
    let failureCode: string | null = null;
    try {
      this.store.assertRunnable(proposalId, attempt.generation, currentContext(context));
      if (controller.signal.aborted) throw new HarnessError('CODEX_PROPOSAL_CANCELLED');
      // 포트가 하위 프로세스와 통신 경로의 정리를 확인하기 전에는 호출 lease를 해제하지 않는다.
      const raw = await this.port.propose(getCodexProposalInput().inputText, controller.signal);
      result = parseCodexProposalResponse(raw);
    } catch (error) {
      failureCode = error instanceof HarnessError && ['CODEX_PROPOSAL_INVALID_RESPONSE', 'CODEX_PROPOSAL_OUTPUT_LIMIT'].includes(error.code)
        ? error.code : 'CODEX_PROPOSAL_CALL_FAILED';
    } finally {
      clearInterval(monitor);
      signal?.removeEventListener('abort', abort);
    }
    const finish = currentContext(context);
    if (controller.signal.aborted || signal?.aborted) this.store.cancel(proposalId, finish);
    return this.store.finish(proposalId, attempt.generation, result, failureCode, finish);
  }

  cancel(proposalId: string, context: CodexProposalContext): CodexProposalSnapshot { return this.store.cancel(proposalId, context); }
  recover(proposalId: string, context: CodexProposalContext): CodexProposalSnapshot { return this.store.recover(proposalId, context); }

  consumeForExecution(proposalId: string, context: CodexProposalContext): CodexProposalExport {
    this.assertConfig(this.store.inspect(proposalId, context).task);
    return this.store.consumeForExecution(proposalId, context);
  }

  private assertConfig(task: CodexProposalTask): void {
    if (task.plan.configHash !== this.configHash) throw new HarnessError('CODEX_PROPOSAL_CONFIG_MISMATCH');
  }
}
