import type { IngestionPolicy } from './types.js';

export interface SlackReceiverConfig extends IngestionPolicy {
  listId?: string;
  listIds?: string[];
  listAnalysisEnabled?: true;
  retentionHours: number;
  maxPending: number;
  thread: { maxMessages: number; maxPages: number; maxBytes: number };
  liveReadEnabled: boolean;
}

export const getSlackListIds = (config: SlackReceiverConfig): readonly string[] =>
  config.listIds ?? (config.listId ? [config.listId] : []);

export interface SlackMessageChange {
  kind: 'created' | 'edited' | 'deleted';
  eventId: string;
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requesterId: string;
  revision: string;
  text: string;
  mentionsTarget: boolean;
}

export interface SlackThreadSnapshot {
  messages: { ts: string; user: string; text: string }[];
  complete: boolean;
  reason: string | null;
}

export interface SlackListAnalysisThread {
  thread: SlackThreadSnapshot;
  mentionTs: string[];
}

export interface SlackInboxItem {
  event: SlackMessageChange;
  state: 'pending' | 'processing' | 'done' | 'blocked';
  receivedAt: string;
  expiresAt: string;
  failureCode: string | null;
}

export interface SlackCollectedRequest {
  workspaceId: string;
  channelId: string;
  listItemId?: string;
  messageTs: string;
  threadTs: string;
  requesterId: string;
  revision: string;
  eventId: string;
  status: 'RECEIVED' | 'RECORDED' | 'INVALIDATED' | 'BLOCKED';
  text: string;
  thread: SlackThreadSnapshot | null;
  updatedAt: string;
  failureCode: string | null;
  /** 수신 기록에만 보관하는 검증값과 수집 건수. 모델로 보내는 스냅샷에는 넣지 않는다. */
  sourceHash?: string;
  receiverHash?: string;
  legacySourceHash?: string;
  messageCount?: number;
}

export interface SlackConnectionState {
  state: 'connected' | 'gap';
  reason: string;
  at: string;
}

export interface SlackInbox {
  receive(event: SlackMessageChange, now: Date): 'accepted' | 'duplicate' | 'ignored';
  pending(): SlackInboxItem[];
  claim(eventId: string, workspaceId: string): boolean;
  complete(event: SlackMessageChange, thread: SlackThreadSnapshot | null, now: Date): void;
  block(event: SlackMessageChange, failureCode: string, now: Date): void;
  recoverInterrupted(now: Date): number;
  list(): SlackCollectedRequest[];
  find(workspaceId: string, channelId: string, messageTs: string): SlackCollectedRequest | null;
  setConnection(state: SlackConnectionState): void;
  connection(): SlackConnectionState | null;
  connectionHistory(): SlackConnectionState[];
  prune(now: Date): number;
  close(): void;
}
