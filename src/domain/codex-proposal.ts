import type { BranchWorkType } from './branch.js';

export const CODEX_PROPOSAL_POLICY_VERSION = 'synthetic-codex-proposal-v1' as const;
export interface CodexProposalContext { ownerId: string; now: Date }
export interface CodexProposalPlan {
  proposalId: string;
  ownerId: string;
  policy: typeof CODEX_PROPOSAL_POLICY_VERSION;
  workType: BranchWorkType;
  inputHash: string;
  configHash: string;
  createdAt: string;
  expiresAt: string;
  planHash: string;
}
export interface CodexProposalResult { path: 'src/message.mjs'; content: string; responseHash: string }
export type CodexProposalStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'READY'
  | 'EXPORTED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
export interface CodexProposalTask {
  proposalId: string;
  plan: CodexProposalPlan;
  status: CodexProposalStatus;
  generation: number;
  updatedAt: string;
  cancelledAt: string | null;
  exportedAt: string | null;
  failureCode: string | null;
  result: CodexProposalResult | null;
}
export interface CodexProposalApprovalRequest { proposalId: string; planHash: string; expiresInMinutes: number }
export interface CodexProposalApproval {
  approvalId: string;
  proposalId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: CodexProposalPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export interface CodexProposalAttempt {
  attemptId: string;
  proposalId: string;
  approvalId: string;
  planHash: string;
  generation: number;
  status: 'RUNNING' | 'READY' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  startedAt: string;
  finishedAt: string | null;
  failureCode: string | null;
  responseHash: string | null;
}
export interface CodexProposalSnapshot {
  task: CodexProposalTask;
  approvals: CodexProposalApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: CodexProposalAttempt | null;
}
export interface CodexProposalExport extends CodexProposalResult {
  proposalId: string;
  workType: BranchWorkType;
  inputHash: string;
  configHash: string;
}
