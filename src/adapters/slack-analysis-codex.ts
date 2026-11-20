import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../domain/readonly-relay.js';
import { SLACK_ANALYSIS_POLICY, type SlackAnalysisModelPort } from '../domain/slack-analysis.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyRelayTransmissionResult } from '../ports/readonly-relay.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { assertSlackAnalysisDispatch, parseSlackAnalysisRelayConfig } from '../policy/slack-analysis.js';
import { RestrictedReadonlyRelayCodex, type SyntheticConnection } from './readonly-relay-codex.js';

const contract = Object.freeze({ policy: SLACK_ANALYSIS_POLICY, assertDispatch: assertSlackAnalysisDispatch });

/** The same fixed relay receives only Slack evidence; no source repository or message-posting port is available. */
export class RestrictedSlackAnalysisCodex implements SlackAnalysisModelPort {
  readonly mode = 'live' as const;
  readonly transport = 'codex-cli-relay' as const;
  private readonly config: ReadonlyRelayConfig;

  constructor(config: ReadonlyRelayConfig, private readonly dataDirectory: string,
    private readonly taskId: string, private readonly synthetic?: SyntheticConnection) {
    this.config = parseSlackAnalysisRelayConfig(config);
    if (!isReadonlyId(taskId)) throw new HarnessError('SLACK_ANALYSIS_INVALID_ID');
  }
  async verifyReady(): Promise<void> {
    await new RestrictedReadonlyRelayCodex(this.config, this.dataDirectory, this.taskId).verifyReady();
  }
  async transmit(dispatch: ReadonlyRelayDispatch, signal: AbortSignal, beforeTransmission: () => void,
    beforeCredentialAccess: () => void): Promise<ReadonlyRelayTransmissionResult> {
    assertSlackAnalysisDispatch(dispatch, this.config);
    return new RestrictedReadonlyRelayCodex(this.config, this.dataDirectory, this.taskId, this.synthetic, contract)
      .transmit(dispatch, signal, beforeTransmission, beforeCredentialAccess);
  }
}
