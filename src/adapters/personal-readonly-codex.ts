import { HarnessError } from '../domain/errors.js';
import { PERSONAL_READONLY_POLICY } from '../domain/personal-readonly.js';
import { PERSONAL_COLLECTION_PLAN_POLICY } from '../domain/personal-readonly-collection.js';
import { PERSONAL_BUDGET_PLAN_POLICY } from '../domain/personal-readonly-budget.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../domain/readonly-relay.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../ports/readonly-relay.js';
import { assertAnyPersonalDispatch } from '../policy/personal-readonly-contract.js';
import { assertPersonalReadonlyDispatch } from '../policy/personal-readonly-policy.js';
import { assertPersonalCollectionDispatch } from '../policy/personal-readonly-collection-policy.js';
import { assertPersonalBudgetDispatch } from '../policy/personal-readonly-budget-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { RestrictedReadonlyRelayCodex, type SyntheticConnection } from './readonly-relay-codex.js';

const personalInputContract = Object.freeze({ policy: PERSONAL_READONLY_POLICY, assertDispatch: assertPersonalReadonlyDispatch });
const collectionInputContract = Object.freeze({ policy: PERSONAL_COLLECTION_PLAN_POLICY, assertDispatch: assertPersonalCollectionDispatch });
const budgetInputContract = Object.freeze({ policy: PERSONAL_BUDGET_PLAN_POLICY, assertDispatch: assertPersonalBudgetDispatch });

/** The approved body selects only a fixed harness validator, never a caller-supplied function. */
export class RestrictedPersonalReadonlyCodex implements ReadonlyRelayPort {
  readonly mode = 'live' as const;
  readonly transport = 'codex-cli-relay' as const;
  constructor(private readonly config: ReadonlyRelayConfig, private readonly dataDirectory: string,
    private readonly investigationId: string, private readonly synthetic?: SyntheticConnection) {
    if (!['readonly-relay-codex-v2', 'readonly-relay-codex-v3'].includes(config.policyVersion)) throw new HarnessError('PERSONAL_READONLY_INVALID_CONFIG');
  }
  async verifyReady(): Promise<void> {
    await new RestrictedReadonlyRelayCodex(this.config, this.dataDirectory, this.investigationId).verifyReady();
  }
  async transmit(dispatch: ReadonlyRelayDispatch, signal: AbortSignal, beforeTransmission: () => void,
    beforeCredentialAccess: () => void): Promise<ReadonlyRelayTransmissionResult> {
    assertAnyPersonalDispatch(dispatch, this.config);
    const request = parseReadonlyTransportJson(dispatch.requestEnvelope.body, 256 * 1024) as { input: { content: { text: string }[] }[] };
    const input = parseReadonlyTransportJson(request.input[0]!.content[0]!.text, 128 * 1024) as { inputPolicyVersion: string };
    const contract = input.inputPolicyVersion === 'personal-readonly-input-v3' ? budgetInputContract
      : input.inputPolicyVersion === 'personal-readonly-input-v2' ? collectionInputContract : personalInputContract;
    return new RestrictedReadonlyRelayCodex(this.config, this.dataDirectory, this.investigationId, this.synthetic, contract)
      .transmit(dispatch, signal, beforeTransmission, beforeCredentialAccess);
  }
}
