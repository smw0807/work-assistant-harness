import type { ReadonlyLimits, ReadonlyPayload, ReadonlyPlan, ReadonlyReport } from './readonly-investigation.js';

export const READONLY_MODEL_PREFLIGHT_POLICY_VERSION = 'synthetic-readonly-model-preflight-v1' as const;
export const READONLY_MODEL_PREFLIGHT_SERIALIZER_VERSION = 'readonly-model-preflight-json-v1' as const;
export const READONLY_MODEL_PREFLIGHT_RESPONSE_VERSION = 'readonly-model-preflight-response-v1' as const;
export type ReadonlyModelPreflightProfileId = 'responses-candidate-json-v1' | 'responses-candidate-sse-v1';
export interface ReadonlyModelPreflightLimits extends ReadonlyLimits {
  requestBytes: number; responseBytes: number; envelopeBytes: number; headerBytes: number; headers: number;
  frameBytes: number; frames: number; responseTimeoutMs: number; cleanupTimeoutMs: number; stderrBytes: number;
}
export interface ReadonlyModelPreflightPayload extends ReadonlyPayload {
  profileId: ReadonlyModelPreflightProfileId;
  requestBody: string;
  requestBodyHash: string;
  requestEnvelope: ReadonlyModelPreflightRequestEnvelope;
  requestEnvelopeHash: string;
  connectionProfileHash: string;
}
export interface ReadonlyModelPreflightPlan extends Omit<ReadonlyPlan, 'policy' | 'mode' | 'model' | 'destination' | 'limits'> {
  policy: typeof READONLY_MODEL_PREFLIGHT_POLICY_VERSION;
  mode: 'offline'; transport: 'in-memory-fake'; responseOrigin: 'synthetic';
  model: 'synthetic-investigator-v1'; destination: 'https://model.invalid/v1/responses';
  profileId: ReadonlyModelPreflightProfileId;
  serializerVersion: typeof READONLY_MODEL_PREFLIGHT_SERIALIZER_VERSION;
  requestBodyHash: string;
  requestEnvelopeHash: string;
  connectionProfileHash: string;
  limits: ReadonlyModelPreflightLimits;
}
export interface ReadonlyModelPreflightResult extends ReadonlyReport {
  mode: 'offline'; transport: 'in-memory-fake'; responseOrigin: 'synthetic'; responseHash: string;
}
export interface ReadonlyModelPreflightRequest {
  model: 'synthetic-investigator-v1'; instructions: string;
  input: [{ role: 'user'; content: [{ type: 'input_text'; text: string }] }];
  tools: []; store: false; stream: boolean;
  text: { format: { type: 'json_schema'; name: 'readonly_report'; strict: true; schema: unknown } };
}
export interface ReadonlyModelPreflightRequestEnvelope {
  profileId: ReadonlyModelPreflightProfileId;
  connectionProfileHash: string;
  method: 'POST'; url: 'https://model.invalid/v1/responses';
  headers: [string, string][];
  body: string; redirect: 'error'; retries: 0;
}
export interface ReadonlyModelPreflightDispatch {
  requestEnvelope: ReadonlyModelPreflightRequestEnvelope;
  requestEnvelopeHash: string;
  requestBodyHash: string;
}
export interface ReadonlyModelPreflightDecodedResponse { text: string; responseHash: string }
