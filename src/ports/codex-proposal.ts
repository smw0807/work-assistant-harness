import type {
  CodexProposalApproval, CodexProposalApprovalRequest, CodexProposalAttempt, CodexProposalContext,
  CodexProposalExport, CodexProposalPlan, CodexProposalResult, CodexProposalSnapshot, CodexProposalTask,
} from '../domain/codex-proposal.js';

export interface CodexProposalPort { propose(input: string, signal?: AbortSignal): Promise<string> }
export interface CodexProposalStore {
  create(plan: CodexProposalPlan, context: CodexProposalContext): CodexProposalTask;
  inspect(proposalId: string, context: CodexProposalContext, offset?: number): CodexProposalSnapshot;
  approve(request: CodexProposalApprovalRequest, context: CodexProposalContext): CodexProposalApproval;
  claim(proposalId: string, planHash: string, context: CodexProposalContext): CodexProposalAttempt;
  assertRunnable(proposalId: string, generation: number, context: CodexProposalContext): void;
  finish(proposalId: string, generation: number, result: CodexProposalResult | null, failureCode: string | null, context: CodexProposalContext): CodexProposalSnapshot;
  cancel(proposalId: string, context: CodexProposalContext): CodexProposalSnapshot;
  recover(proposalId: string, context: CodexProposalContext): CodexProposalSnapshot;
  consumeForExecution(proposalId: string, context: CodexProposalContext): CodexProposalExport;
  close(): void;
}
