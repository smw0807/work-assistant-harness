import type { ReadonlyLimits, ReadonlyPayload, ReadonlyPlan, ReadonlyReport } from './readonly-investigation.js';

export const READONLY_TRANSPORT_POLICY_VERSION = 'synthetic-readonly-transport-v1' as const;
export const READONLY_TRANSPORT_SERIALIZER_VERSION = 'readonly-transport-json-v1' as const;
export const READONLY_TRANSPORT_RESPONSE_VERSION = 'readonly-transport-response-v1' as const;
export type ReadonlyTransportProfileId = 'synthetic-json-v1' | 'synthetic-stream-v1';
export interface ReadonlyTransportLimits extends ReadonlyLimits { requestBytes: number; responseBytes: number }
export interface ReadonlyTransportPayload extends ReadonlyPayload {
  profileId: ReadonlyTransportProfileId;
  requestBody: string;
  requestBodyHash: string;
}
export interface ReadonlyTransportPlan extends Omit<ReadonlyPlan, 'policy' | 'mode' | 'model' | 'destination' | 'limits'> {
  policy: typeof READONLY_TRANSPORT_POLICY_VERSION;
  mode: 'offline'; transport: 'fake'; responseOrigin: 'synthetic';
  model: 'synthetic-investigator-v1'; destination: 'local:readonly-transport';
  profileId: ReadonlyTransportProfileId;
  serializerVersion: typeof READONLY_TRANSPORT_SERIALIZER_VERSION;
  requestBodyHash: string;
  limits: ReadonlyTransportLimits;
}
export interface ReadonlyTransportResult extends ReadonlyReport {
  mode: 'offline'; transport: 'fake'; responseOrigin: 'synthetic'; responseHash: string;
}
export interface ReadonlyTransportRequest {
  version: typeof READONLY_TRANSPORT_SERIALIZER_VERSION;
  profileId: ReadonlyTransportProfileId;
  model: 'synthetic-investigator-v1'; instructions: string; input: string;
  tools: []; store: false; stream: boolean;
  responseFormat: { type: 'json_schema'; name: 'readonly_report'; strict: true; schemaVersion: 'readonly-report-v1'; schema: unknown };
}
