/** This observation describes safe reads, never authority to resume or roll back writes. */
export interface SyntheticCompanyChangeObservation {
  version: 'synthetic-company-change-observation-v1';
  taskId: string;
  planHash: string;
  branch: 'base' | 'target' | 'other' | 'unknown';
  files: Array<{ path: string; state: 'before' | 'after' | 'absent' | 'other' | 'unsafe'; hash: string | null }>;
  indexPreserved: boolean | null;
  basePreserved: boolean | null;
  residuals: number | null;
  /** True only when the bounded, stable, safe tree observation completed; it does not mean APPLIED. */
  complete: boolean;
}
