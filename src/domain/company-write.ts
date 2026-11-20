/** Registration declarations do not prove filesystem identity or authorize an actual company run. */
export interface CompanyWriteRegistration {
  version: 'company-write-registration-v1';
  repoId: string;
  sourceRoot: string;
  baseBranch: string;
  baseCommit: string;
  baseIndexHash: string;
  writeAllowedFiles: string[];
  enabled: boolean;
  localRead: 'unconfirmed' | 'allowed';
  localWrite: 'unconfirmed' | 'allowed';
}

export interface CompanyWriteSourceFile {
  path: string;
  beforeHash: string | null;
  mode: number | null;
  identityHash: string | null;
  parentIdentityHash: string;
}

export interface CompanyWriteSource {
  rootIdentityHash: string;
  headHash: string;
  indexHash: string;
  baseRefHash: string;
  files: CompanyWriteSourceFile[];
}

export interface CompanyWriteDescriptor {
  operation: 'replace' | 'create';
  path: string;
  beforeHash: string | null;
  afterHash: string;
  bytes: number;
}

/** This version is for isolated synthetic validation; it cannot activate company-source writes. */
export interface CompanyWritePlan {
  version: 'company-write-plan-v1';
  id: string;
  ownerId: string;
  registrationHash: string;
  draftHash: string;
  source: CompanyWriteSource;
  branch: string;
  changes: CompanyWriteDescriptor[];
  createdAt: string;
  expiresAt: string;
  limitsHash: string;
  planHash: string;
  scope: 'synthetic-validation';
  checks: 'not_run';
  transmissionAllowed: false;
}

export interface CompanyWriteApprovalRequest {
  taskId: string;
  planHash: string;
  expiresInMinutes: number;
}

export interface CompanyWriteApproval {
  version: 'company-write-approval-v1';
  id: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  scope: 'synthetic-validation';
}
