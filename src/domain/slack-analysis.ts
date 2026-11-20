import type { ReadonlyRelayDispatch } from './readonly-relay.js';
import type { ReadonlyRelayPort } from '../ports/readonly-relay.js';

export const SLACK_ANALYSIS_POLICY = 'slack-mention-analysis-v1' as const;
export interface SlackAnalysisSource {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  requesterId: string;
  targetUserId: string;
  revision: string;
  eventId: string;
  updatedAt: string;
}
/** path is a virtual citation label, never a filesystem path or permission. */
export interface SlackAnalysisEvidence {
  evidenceId: string;
  path: string;
  ts: string;
  user: string;
  startLine: 1;
  endLine: number;
  excerpt: string;
}
export interface SlackAnalysisPayload {
  version: typeof SLACK_ANALYSIS_POLICY;
  sourceHash: string;
  receiverHash: string;
  configHash: string;
  source: SlackAnalysisSource;
  evidence: SlackAnalysisEvidence[];
  dispatch: ReadonlyRelayDispatch;
}
export type SlackAnalysisModelPort = ReadonlyRelayPort;
