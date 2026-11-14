import type { ReadonlyLimits, ReadonlyPayload, ReadonlyPlan, ReadonlyReport } from './readonly-investigation.js';

export const READONLY_RELAY_POLICY_VERSION = 'synthetic-readonly-relay-v1' as const;
export const READONLY_RELAY_SERIALIZER_VERSION = 'readonly-relay-json-v1' as const;
export const READONLY_RELAY_RESPONSE_VERSION = 'codex-native-output-v1' as const;
export const READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS = Object.freeze({
  providerMetadata: 'not_inspected', providerSequence: 'not_inspected', providerToolUsage: 'not_inspected',
  rawSensitiveScan: 'not_performed', parentTextComparison: 'not_performed',
} as const);
export type ReadonlyRelayProfileId = 'codex-chatgpt-relay-v1';
export interface ReadonlyRelayConfig {
  enabled: boolean;
  policyVersion: 'readonly-relay-codex-v1';
  codexPath: string;
  codexSha256: string;
  model: 'gpt-6.1-sol';
  authMode: 'chatgpt';
  timeoutMs: 60000;
  maxResponseBytes: 16384;
}
export interface ReadonlyRelayLimits extends ReadonlyLimits {
  requestBytes: number; responseBytes: number; envelopeBytes: number; headerBytes: number; headers: number;
  responseHeaderBytes?: number; responseHeaders?: number;
  frameBytes: number; frames: number; responseTimeoutMs: number; cleanupTimeoutMs: number; stderrBytes: number;
}
export interface ReadonlyRelayPayload extends ReadonlyPayload {
  profileId: ReadonlyRelayProfileId;
  requestBody: string;
  requestBodyHash: string;
  requestEnvelope: ReadonlyRelayRequestEnvelope;
  requestEnvelopeHash: string;
  connectionProfileHash: string;
}
export interface ReadonlyRelayPlan extends Omit<ReadonlyPlan, 'policy' | 'mode' | 'model' | 'destination' | 'limits' | 'authentication'> {
  policy: typeof READONLY_RELAY_POLICY_VERSION;
  mode: 'live'; transport: 'codex-cli-relay'; responseOrigin: 'model';
  model: 'gpt-6.1-sol'; destination: 'https://chatgpt.com/backend-api/codex/responses';
  authentication: 'chatgpt'; configSnapshot: ReadonlyRelayConfig;
  profileId: ReadonlyRelayProfileId;
  serializerVersion: typeof READONLY_RELAY_SERIALIZER_VERSION;
  requestBodyHash: string;
  requestEnvelopeHash: string;
  connectionProfileHash: string;
  limits: ReadonlyRelayLimits;
}
export interface ReadonlyRelayResult extends ReadonlyReport {
  mode: 'live'; transport: 'codex-cli-relay'; responseOrigin: 'model'; responseHash: string;
}
export interface ReadonlyRelayRequest {
  model: 'gpt-6.1-sol'; instructions: string;
  input: [{ role: 'user'; content: [{ type: 'input_text'; text: string }] }];
  tools: []; store: false; stream: true;
  text: { format: { type: 'json_schema'; name: 'readonly_report'; strict: true; schema: unknown } };
}
export interface ReadonlyRelayRequestEnvelope {
  profileId: ReadonlyRelayProfileId;
  connectionProfileHash: string;
  method: 'POST'; url: 'https://chatgpt.com/backend-api/codex/responses';
  headers: [string, string][];
  body: string; redirect: 'error'; retries: 0;
}
export interface ReadonlyRelayDispatch {
  requestEnvelope: ReadonlyRelayRequestEnvelope;
  requestEnvelopeHash: string;
  requestBodyHash: string;
}
export interface ReadonlyRelayDecodedResponse { text: string; responseHash: string; finalTextHash: string }
