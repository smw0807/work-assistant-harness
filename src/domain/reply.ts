export type ReplyFixture = 'success' | 'not-sent' | 'unknown' | 'incomplete' | 'gap';
export type ReplyStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'SENDING' | 'SIMULATED' | 'FAILED' | 'UNKNOWN' | 'BLOCKED' | 'CANCELLED';

export interface ReplyRetention {
  bodyRetentionHours: number;
  // null은 합성 감사 메타데이터를 DB 수명 동안 보관한다는 명시적 설정이다.
  auditRetentionDays: number | null;
}

export interface ReplySource {
  requestId: string;
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requesterId: string;
  requestRevision: number;
  contextRevision: number;
  complete: boolean;
  gap: boolean;
  expiresAt: string;
}

/** 본문은 별도 만료 payload에만 보관한다. 승인 snapshot에도 이 메타데이터만 복제한다. */
export interface ReplyPlan {
  taskId: string;
  ownerId: string;
  policy: 'synthetic-reply-v1';
  mode: 'mock';
  fixture: ReplyFixture;
  source: ReplySource;
  destination: { workspaceId: string; channelId: string; threadTs: string };
  bodyHash: string;
  bodyBytes: number;
  createdAt: string;
  expiresAt: string;
  retention: ReplyRetention;
  planHash: string;
}

export interface ReplyTask {
  taskId: string;
  plan: ReplyPlan;
  status: ReplyStatus;
  generation: number;
  requestRevision: number;
  contextRevision: number;
  invalidatedAt: string | null;
  failureCode: string | null;
  updatedAt: string;
}

export interface ReplyApproval {
  approvalId: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: ReplyPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  reason: string | null;
}

export interface ReplyApprovalRequest {
  taskId: string;
  planHash: string;
  expiresInMinutes: number;
}

export interface ReplyAttempt {
  attemptId: string;
  taskId: string;
  approvalId: string;
  planHash: string;
  generation: number;
  status: 'SENDING' | 'SIMULATED' | 'NOT_SENT' | 'UNKNOWN';
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  receiptId: string | null;
}

export type ReplyControlKind = 'cancel' | 'edited' | 'deleted' | 'reply' | 'gap' | 'incomplete' | 'expired';
export interface ReplyControl {
  taskId: string;
  eventId: string;
  kind: ReplyControlKind;
  revision: number;
}

export interface ReplySnapshot {
  task: ReplyTask;
  body: string | null;
  approvals: ReplyApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempts: ReplyAttempt[];
  attemptTotal: number;
}

export interface ReplyClaim {
  task: ReplyTask;
  body: string;
  attempt: ReplyAttempt;
}

export interface ReplyDeliveryResult {
  status: 'SIMULATED' | 'NOT_SENT' | 'UNKNOWN';
  reason: string | null;
  receiptId: string | null;
}
