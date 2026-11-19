import { HarnessError } from '../domain/errors.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../domain/readonly-relay.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../ports/readonly-relay.js';
import { assertCompanyRelayAccount, assertCompanyRelayDispatch } from '../policy/company-relay.js';
import { parseAnyReadonlyRelayConfig } from '../policy/readonly-relay-budget-policy.js';
import { RestrictedReadonlyRelayCodex, type ReadonlyRelayInputContract } from './readonly-relay-codex.js';

/** Company input and the declared account are bound by trusted code, before the broker sends anything. */
export class RestrictedCompanyRelayCodex implements ReadonlyRelayPort {
  readonly mode = 'live' as const;
  readonly transport = 'codex-cli-relay' as const;
  private readonly config: ReadonlyRelayConfig;
  private readonly contract: ReadonlyRelayInputContract;

  constructor(config: ReadonlyRelayConfig, private readonly dataDirectory: string,
    private readonly investigationId: string, accountIdHash: string, ipcDirectory?: string) {
    this.config = parseAnyReadonlyRelayConfig(config);
    if (this.config.policyVersion !== 'readonly-relay-codex-v3' || !/^[a-f0-9]{64}$/u.test(accountIdHash)
      || ipcDirectory !== undefined && !/^\/private\/tmp\/hcri-[A-Za-z0-9]{6}$/u.test(ipcDirectory)) {
      throw new HarnessError('COMPANY_RELAY_INVALID_CONFIG');
    }
    this.contract = Object.freeze({ policy: 'company-relay-plan-v1', assertDispatch: assertCompanyRelayDispatch,
      assertCredential: (credential) => {
        try { assertCompanyRelayAccount(credential.accountId, accountIdHash); }
        catch { throw new HarnessError('READONLY_RELAY_ACCOUNT_MISMATCH'); }
      }, ...(ipcDirectory === undefined ? {} : { ipcDirectory }) });
  }

  async verifyReady(): Promise<void> {
    await new RestrictedReadonlyRelayCodex(this.config, this.dataDirectory, this.investigationId).verifyReady();
  }

  async transmit(dispatch: ReadonlyRelayDispatch, signal: AbortSignal, beforeTransmission: () => void,
    beforeCredentialAccess: () => void): Promise<ReadonlyRelayTransmissionResult> {
    assertCompanyRelayDispatch(dispatch, this.config);
    return new RestrictedReadonlyRelayCodex(this.config, this.dataDirectory, this.investigationId, undefined, this.contract)
      .transmit(dispatch, signal, beforeTransmission, beforeCredentialAccess);
  }
}
