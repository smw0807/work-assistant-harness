import { HarnessError } from '../domain/errors.js';
import type { SlackInbox, SlackReceiverConfig, SlackThreadSnapshot } from '../domain/slack.js';
import { normalizeSlackChange, parseSocketEnvelope } from '../policy/slack-ingestion.js';
import { redactSlackText } from '../policy/redaction.js';

export interface SlackThreadReader {
  readThread(channelId: string, threadTs: string, limits: SlackReceiverConfig['thread']): Promise<SlackThreadSnapshot>;
}

/** 수신 ACK는 모델·저장소 조사와 분리하고 SQLite commit 이후에만 보낸다. */
export class SlackReceptionService {
  private draining: Promise<void> | null = null;

  constructor(
    private readonly config: SlackReceiverConfig,
    private readonly inbox: SlackInbox,
    private readonly threads: SlackThreadReader,
    private readonly now: () => Date = () => new Date(),
    private readonly signal?: AbortSignal,
  ) {}

  async receive(input: unknown, acknowledge: () => Promise<void>): Promise<'accepted' | 'duplicate' | 'ignored'> {
    const envelope = parseSocketEnvelope(input);
    const event = envelope ? normalizeSlackChange(envelope.payload, this.config) : null;
    if (!event) {
      await acknowledge();
      return 'ignored';
    }
    const now = this.now();
    this.inbox.prune(now);
    const result = this.inbox.receive(event, now);
    await acknowledge();
    return result;
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drainPending().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async drainPending(): Promise<void> {
    for (;;) {
      if (this.signal?.aborted) return;
      this.inbox.prune(this.now());
      const item = this.inbox.pending()[0];
      if (!item) return;
      const event = item.event;
      if (!this.inbox.claim(event.eventId, event.workspaceId)) continue;
      try {
        let snapshot: SlackThreadSnapshot | null = null;
        if (event.kind !== 'deleted' && event.mentionsTarget) {
          if (event.workspaceId !== this.config.workspaceId || !this.config.channelIds.includes(event.channelId)) {
            throw new HarnessError('SLACK_THREAD_SCOPE_DENIED');
          }
          const read = await this.threads.readThread(event.channelId, event.threadTs, this.config.thread);
          if (this.signal?.aborted) throw new HarnessError('SLACK_COLLECTION_INTERRUPTED');
          snapshot = {
            complete: read.complete,
            reason: read.reason && /^[A-Z][A-Z0-9_]{1,80}$/.test(read.reason) ? read.reason : read.complete ? null : 'SLACK_THREAD_INCOMPLETE',
            messages: read.messages.slice(0, this.config.thread.maxMessages).map((message) => ({
              ts: message.ts, user: message.user, text: redactSlackText(message.text),
            })),
          };
          if (Buffer.byteLength(JSON.stringify(snapshot.messages), 'utf8') > this.config.thread.maxBytes) {
            throw new HarnessError('SLACK_THREAD_SIZE_LIMIT');
          }
        }
        this.inbox.complete(event, snapshot, this.now());
      } catch (error) {
        const code = error instanceof HarnessError ? error.code : 'SLACK_COLLECTION_FAILED';
        this.inbox.block(event, code, this.now());
      }
    }
  }
}
