import { HarnessError } from '../domain/errors.js';
import { PERSONAL_READONLY_POLICY } from '../domain/personal-readonly.js';
import type { ReadonlyRelayConfig } from '../domain/readonly-relay.js';
import { assertPersonalReadonlyDispatch } from '../policy/personal-readonly-policy.js';
import { RestrictedReadonlyRelayCodex, type SyntheticConnection } from './readonly-relay-codex.js';

const personalInputContract = Object.freeze({ policy: PERSONAL_READONLY_POLICY, assertDispatch: assertPersonalReadonlyDispatch });

/** Shares the unchanged v2 transport while fixing the separate personal-evidence input validator in code. */
export class RestrictedPersonalReadonlyCodex extends RestrictedReadonlyRelayCodex {
  constructor(config: ReadonlyRelayConfig, dataDirectory: string, investigationId: string, synthetic?: SyntheticConnection) {
    if (config.policyVersion !== 'readonly-relay-codex-v2') throw new HarnessError('PERSONAL_READONLY_INVALID_CONFIG');
    super(config, dataDirectory, investigationId, synthetic, personalInputContract);
  }
}
