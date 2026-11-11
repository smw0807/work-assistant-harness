export interface LiveSlackConfig {
  policy: 'slack-live-test-v1';
  liveEnabled: boolean;
  workspaceId: string;
  channelId: string;
  threadTs: string;
}

export interface LiveSource {
  botId: string;
  botUserId: string;
  rootRevision: string;
  contextHash: string;
  observedAt: string;
}

export interface LivePlan {
  taskId: string;
  ownerId: string;
  policy: 'slack-live-test-v1';
  mode: 'live-test';
  config: LiveSlackConfig;
  source: LiveSource;
  bodyHash: string;
  bodyBytes: number;
  createdAt: string;
  expiresAt: string;
  planHash: string;
}

export type LiveStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN' | 'BLOCKED' | 'CANCELLED';
export interface LiveTask {
  plan: LivePlan;
  status: LiveStatus;
  updatedAt: string;
  reason: string | null;
}

export interface LiveApproval {
  approvalId: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: LivePlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface LiveReceipt {
  channelId: string;
  threadTs: string;
  messageTs: string;
}

export interface LiveAttempt {
  attemptId: string;
  taskId: string;
  approvalId: string;
  planHash: string;
  status: 'SENDING' | 'SENT' | 'NOT_SENT' | 'UNKNOWN';
  startedAt: string;
  finishedAt: string | null;
  receipt: LiveReceipt | null;
  reason: string | null;
}

export interface LiveClaim {
  task: LiveTask;
  approval: LiveApproval;
  attempt: LiveAttempt;
  checkedAt: string;
}

export interface LiveDeliveryResult {
  status: 'SENT' | 'NOT_SENT' | 'UNKNOWN';
  reason: string | null;
  receipt: LiveReceipt | null;
}

export interface LiveSnapshot {
  task: LiveTask;
  approvals: LiveApproval[];
  attempts: LiveAttempt[];
  body: string | null;
}
