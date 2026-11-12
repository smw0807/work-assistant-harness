export const READONLY_POLICY_VERSION = 'synthetic-readonly-investigation-v1' as const;
export const READONLY_SCHEMA_VERSION = 'readonly-report-v1' as const;
export interface ReadonlyContext { ownerId: string; now: Date }
export interface ReadonlyRange { path: string; startLine: number; endLine: number }
export interface ReadonlyEntryIdentity {
  path: string; kind: 'file' | 'directory'; hash: string; size: number; mode: number;
  device: number; inode: number; links: number; uid: number; modified: string; changed: string;
}
export interface ReadonlyParentIdentity { path: string; device: number; inode: number; mode: number; uid: number }
/** Local filesystem identities never enter the transmitted input or approval snapshot. */
export interface ReadonlyRepository {
  id: string; fixtureId: 'flow'; repoId: string; sourceRoot: string; baseCommit: string;
  sourceManifestHash: string; identityHash: string; manifest: ReadonlyEntryIdentity[];
  parents: ReadonlyParentIdentity[]; readAllowedFiles: string[];
}
export interface ReadonlySelection {
  requestId: 'flow-question' | 'change-request'; requestRevision: number;
  readRanges: ReadonlyRange[]; transferEvidenceIds?: string[];
}
export interface ReadonlyEvidence extends ReadonlyRange {
  evidenceId: string; repoId: string; baseCommit: string; fileHash: string; excerptHash: string; excerpt: string;
}
export interface ReadonlySnapshot {
  policy: typeof READONLY_POLICY_VERSION; repoId: string; baseCommit: string; sourceManifestHash: string;
  readAllowedFiles: string[]; readRanges: ReadonlyRange[]; evidence: ReadonlyEvidence[]; contextHash: string;
}
export interface ReadonlyRequest { id: ReadonlySelection['requestId']; revision: number; body: string; hash: string }
export interface ReadonlyPayload {
  repository: ReadonlyRepository; request: ReadonlyRequest; context: ReadonlySnapshot;
  transferEvidenceIds: string[]; inputText: string; inputHash: string; createdAt: string; expiresAt: string;
}
export interface ReadonlyLimits {
  files: number; ranges: number; linesPerRange: number; fileBytes: number; evidenceBytes: number;
  inputBytes: number; outputBytes: number; calls: number; timeoutSeconds: number;
}
export interface ReadonlyPlan {
  id: string; ownerId: string; policy: typeof READONLY_POLICY_VERSION; fixtureId: 'flow'; repoId: string;
  baseCommit: string; sourceManifestHash: string; repositoryIdentityHash: string;
  requestId: ReadonlySelection['requestId']; requestRevision: number; requestHash: string;
  readAllowedFiles: string[]; readRanges: ReadonlyRange[]; transferEvidenceIds: string[];
  writeAllowedFiles: []; testCommandIds: []; executionAllowed: false;
  contextHash: string; inputHash: string; schemaVersion: typeof READONLY_SCHEMA_VERSION;
  mode: 'mock'; model: 'fixed-readonly-v1'; destination: 'local:fixed-response'; authentication: 'none';
  configHash: string; limits: ReadonlyLimits; createdAt: string; expiresAt: string; planHash: string;
}
export interface ReadonlyReference { evidenceId: string; startLine: number; endLine: number }
export interface ReadonlyStatement { text: string; references: ReadonlyReference[] }
export interface ReadonlyReport {
  classification: 'question' | 'change-request' | 'insufficient-evidence'; summary: string;
  facts: ReadonlyStatement[]; hypotheses: ReadonlyStatement[]; answerDraft: string; questions: string[];
  suggestions: { path: string; description: string; references: ReadonlyReference[] }[]; limitations: string[];
}
export interface ReadonlyResult extends ReadonlyReport { mode: 'mock'; responseHash: string }
