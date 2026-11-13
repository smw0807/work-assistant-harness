import type { ReadonlyLimits, ReadonlyPayload, ReadonlyPlan, ReadonlyReport } from './readonly-investigation.js';

export const READONLY_LIVE_POLICY_VERSION = 'synthetic-readonly-live-v1' as const;
export const READONLY_LIVE_SERIALIZER_VERSION = 'readonly-live-json-v1' as const;
export const READONLY_LIVE_RESPONSE_VERSION = 'readonly-live-response-v1' as const;
export const READONLY_LIVE_RESPONSE_EXTENSION_LIMITS = Object.freeze({ fields: 8, keyCharacters: 64, bytes: 16384, nodes: 256, depth: 8 });
export type ReadonlyLiveProfileId = 'codex-chatgpt-sse-v1' | 'codex-chatgpt-sse-v2' | 'codex-chatgpt-sse-v3' | 'codex-chatgpt-sse-v4' | 'codex-chatgpt-sse-v5' | 'codex-chatgpt-sse-v6' | 'codex-chatgpt-sse-v7' | 'codex-chatgpt-sse-v8' | 'codex-chatgpt-sse-v9';
export interface ReadonlyLiveConfig {
  enabled: boolean;
  policyVersion: 'readonly-live-codex-v1' | 'readonly-live-codex-v2' | 'readonly-live-codex-v3' | 'readonly-live-codex-v4' | 'readonly-live-codex-v5' | 'readonly-live-codex-v6' | 'readonly-live-codex-v7' | 'readonly-live-codex-v8' | 'readonly-live-codex-v9';
  codexPath: string;
  codexSha256: string;
  model: 'gpt-6.1-sol';
  authMode: 'chatgpt';
  timeoutMs: 60000;
  maxResponseBytes: 16384;
}
export interface ReadonlyLiveLimits extends ReadonlyLimits {
  requestBytes: number; responseBytes: number; envelopeBytes: number; headerBytes: number; headers: number;
  responseHeaderBytes?: number; responseHeaders?: number;
  frameBytes: number; frames: number; responseTimeoutMs: number; cleanupTimeoutMs: number; stderrBytes: number;
}
export interface ReadonlyLivePayload extends ReadonlyPayload {
  profileId: ReadonlyLiveProfileId;
  requestBody: string;
  requestBodyHash: string;
  requestEnvelope: ReadonlyLiveRequestEnvelope;
  requestEnvelopeHash: string;
  connectionProfileHash: string;
}
export interface ReadonlyLivePlan extends Omit<ReadonlyPlan, 'policy' | 'mode' | 'model' | 'destination' | 'limits' | 'authentication'> {
  policy: typeof READONLY_LIVE_POLICY_VERSION;
  mode: 'live'; transport: 'codex-cli-broker'; responseOrigin: 'model';
  model: 'gpt-6.1-sol'; destination: 'https://chatgpt.com/backend-api/codex/responses';
  authentication: 'chatgpt'; configSnapshot: ReadonlyLiveConfig;
  profileId: ReadonlyLiveProfileId;
  serializerVersion: typeof READONLY_LIVE_SERIALIZER_VERSION;
  requestBodyHash: string;
  requestEnvelopeHash: string;
  connectionProfileHash: string;
  limits: ReadonlyLiveLimits;
}
export interface ReadonlyLiveResult extends ReadonlyReport {
  mode: 'live'; transport: 'codex-cli-broker'; responseOrigin: 'model'; responseHash: string;
}
export interface ReadonlyLiveRequest {
  model: 'gpt-6.1-sol'; instructions: string;
  input: [{ role: 'user'; content: [{ type: 'input_text'; text: string }] }];
  tools: []; store: false; stream: true;
  text: { format: { type: 'json_schema'; name: 'readonly_report'; strict: true; schema: unknown } };
}
export interface ReadonlyLiveRequestEnvelope {
  profileId: ReadonlyLiveProfileId;
  connectionProfileHash: string;
  method: 'POST'; url: 'https://chatgpt.com/backend-api/codex/responses';
  headers: [string, string][];
  body: string; redirect: 'error'; retries: 0;
}
export interface ReadonlyLiveDispatch {
  requestEnvelope: ReadonlyLiveRequestEnvelope;
  requestEnvelopeHash: string;
  requestBodyHash: string;
}
export interface ReadonlyLiveDecodedResponse { text: string; responseHash: string }
