import { DisabledSlackPostHttp, SlackPostMessageAdapter } from '../adapters/slack-post-message.js';
import { OfflineSlackHttp } from '../adapters/offline-slack-http.js';
import { HarnessError } from '../domain/errors.js';
import { slackPostFixtures, type SlackPostCheckReport, type SlackPostFixture, type SlackPostResult } from '../domain/slack-post.js';
import { createOfflinePostIntent, defaultSlackPostConfig } from '../policy/slack-post-policy.js';

const expectedStatus: Record<SlackPostFixture, SlackPostResult['status']> = {
  success: 'OFFLINE_CONFIRMED', disabled: 'BLOCKED', 'auth-mismatch': 'BLOCKED',
  'source-changed': 'BLOCKED', 'new-reply': 'BLOCKED', incomplete: 'BLOCKED', expired: 'BLOCKED',
  denied: 'NOT_SENT', 'rate-limited': 'NOT_SENT', 'server-error': 'UNKNOWN', timeout: 'UNKNOWN',
  malformed: 'UNKNOWN', oversized: 'UNKNOWN', 'receipt-mismatch': 'UNKNOWN', redirect: 'UNKNOWN',
};

const expectedCalls = (fixture: SlackPostFixture): SlackPostResult['calls'] => {
  if (fixture === 'disabled' || fixture === 'expired') return { auth: 0, thread: 0, post: 0 };
  if (fixture === 'auth-mismatch') return { auth: 1, thread: 0, post: 0 };
  return { auth: 1, thread: 1, post: expectedStatus[fixture] === 'BLOCKED' ? 0 : 1 };
};

/** 독립 진단 경로다. Task·승인·Run을 만들지 않으며 실제 전송 권한도 발급하지 않는다. */
export class SlackPostCheckService {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async verify(fixture: SlackPostFixture | 'all', ownerId: string, verificationId: string): Promise<SlackPostCheckReport> {
    if (fixture !== 'all' && !slackPostFixtures.includes(fixture)) throw new HarnessError('SLACK_POST_INVALID_FIXTURE');
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(verificationId)) throw new HarnessError('SLACK_POST_INVALID_VERIFICATION');
    const now = this.clock();
    const fixtures = fixture === 'all' ? slackPostFixtures : [fixture];
    const scenarios: SlackPostCheckReport['scenarios'] = [];
    for (const selected of fixtures) {
      const intent = createOfflinePostIntent(ownerId, now);
      const transport = selected === 'disabled' ? new DisabledSlackPostHttp() : new OfflineSlackHttp(selected);
      const adapterClock = selected === 'expired' ? () => new Date(now.getTime() + 60_000) : this.clock;
      const adapter = new SlackPostMessageAdapter(transport, adapterClock);
      const result = await adapter.verify(intent, { ...defaultSlackPostConfig });
      const expected = expectedStatus[selected];
      const calls = expectedCalls(selected);
      scenarios.push({ fixture: selected, expected, status: result.status === expected
        && result.calls.auth === calls.auth && result.calls.thread === calls.thread && result.calls.post === calls.post
        ? 'passed' : 'failed', result });
    }
    // 단일 fixture를 골라도 기본 disabled 경계는 별도로 확인한다.
    const disabled = await new SlackPostMessageAdapter().verify(createOfflinePostIntent(ownerId, now), { ...defaultSlackPostConfig });
    const gatePassed = disabled.status === 'BLOCKED' && disabled.calls.auth === 0 && disabled.calls.thread === 0 && disabled.calls.post === 0;
    const passed = gatePassed && scenarios.every((scenario) => scenario.status === 'passed');
    return {
      verificationId, createdAt: now.toISOString(), policy: 'slack-post-contract-v1', mode: 'offline-http', liveEnabled: false,
      status: passed ? 'passed' : 'failed', scenarios,
      checks: [
        { name: 'live_gate_closed', status: gatePassed ? 'passed' : 'failed', reason: '기본 비활성 transport는 HTTP를 호출하지 않으며 실제 네트워크 구현과 활성화 옵션을 제공하지 않습니다.' },
        { name: 'offline_http_contract', status: scenarios.every((scenario) => scenario.status === 'passed') ? 'passed' : 'failed',
          reason: '고정 합성 HTTP 응답의 인증·문맥·직렬화·결과 분류와 요청 횟수를 대조했습니다. 진단 입력은 전송 승인이 아닙니다.' },
        { name: 'external_message_delivery', status: 'not_run', reason: '실제 Slack·토큰·회사 자료·live 승인·전송은 연결하지 않았습니다.' },
      ],
    };
  }
}
