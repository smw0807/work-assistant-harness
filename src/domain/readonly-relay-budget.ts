import type { ReadonlyRelayConfig } from './readonly-relay.js';

export type AnyReadonlyRelayConfig = ReadonlyRelayConfig;
export const READONLY_RELAY_EXECUTION_BUDGET_POLICY = 'readonly-relay-execution-budget-v1' as const;
export interface ReadonlyRelayExecutionBudget {
  readonly policy: typeof READONLY_RELAY_EXECUTION_BUDGET_POLICY | 'readonly-relay-legacy-execution-budget-v1';
  readonly workTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly frames: number;
  readonly responseBytes: number;
  readonly frameBytes: number;
  readonly jsonDepth: number;
  readonly outputBytes: number;
  readonly nativeOutputBytes: number;
  readonly stderrBytes: number;
}
