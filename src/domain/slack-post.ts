export const slackPostFixtures = [
  'success', 'disabled', 'auth-mismatch', 'source-changed', 'new-reply', 'incomplete', 'expired',
  'denied', 'rate-limited', 'server-error', 'timeout', 'malformed', 'oversized', 'receipt-mismatch', 'redirect',
] as const;
export type SlackPostFixture = typeof slackPostFixtures[number];

export interface SlackPostConfig {
  policy: 'slack-post-contract-v1';
  liveEnabled: false;
  workspaceId: string;
  channelId: string;
  botId: string;
  botUserId: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

export interface PostThreadMessage {
  ts: string;
  user: string;
  text: string;
  revision: string;
}

/** 진단용 HTTP 입력이다. 소유자의 전송 승인이나 영속 승인 소비를 대체하지 않는다. */
export interface OfflinePostIntent {
  policy: 'slack-post-contract-v1';
  mode: 'offline-http';
  operationId: string;
  ownerId: string;
  configHash: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  requestRevision: string;
  contextHash: string;
  bodyHash: string;
  createdAt: string;
  expiresAt: string;
  intentHash: string;
}

export interface SlackPostResult {
  status: 'OFFLINE_CONFIRMED' | 'NOT_SENT' | 'UNKNOWN' | 'BLOCKED';
  code: string | null;
  intentHash: string;
  receipt: { channelId: string; messageTs: string; threadTs: string } | null;
  calls: { auth: number; thread: number; post: number };
}

export interface SlackPostCheckReport {
  verificationId: string;
  createdAt: string;
  policy: 'slack-post-contract-v1';
  mode: 'offline-http';
  liveEnabled: false;
  status: 'passed' | 'failed';
  scenarios: { fixture: SlackPostFixture; expected: SlackPostResult['status']; status: 'passed' | 'failed'; result: SlackPostResult }[];
  checks: { name: string; status: 'passed' | 'failed' | 'not_run'; reason: string }[];
}
