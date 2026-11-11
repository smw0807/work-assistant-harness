import type { OfflinePostIntent, SlackPostConfig, SlackPostResult } from '../domain/slack-post.js';

export interface SlackPostHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: 'error';
  signal: AbortSignal;
}

/** 실제 fetch 구현은 이 단계에서 제공하지 않는다. 전송 경로는 disabled 또는 합성 HTTP뿐이다. */
export interface SlackPostHttpPort {
  readonly mode: 'disabled' | 'offline';
  request(request: SlackPostHttpRequest): Promise<Response>;
}

export interface SlackPostContractPort {
  readonly liveEnabled: false;
  verify(intent: OfflinePostIntent, config: SlackPostConfig, signal?: AbortSignal): Promise<SlackPostResult>;
}
