import { HarnessError } from '../domain/errors.js';

const timestampPattern = /^\d{1,20}\.\d{1,10}$/;

export const isSlackTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && timestampPattern.test(value);

/** Slack 시각의 소수 자릿수를 보존해 같은 초 안의 답글 순서를 비교한다. */
export const slackTimestampTicks = (value: string): bigint => {
  if (!isSlackTimestamp(value)) throw new HarnessError('INVALID_SLACK_REVISION');
  const [seconds = '', fraction = ''] = value.split('.');
  return BigInt(seconds) * 10_000_000_000n + BigInt(fraction.padEnd(10, '0'));
};

export const compareSlackTimestamps = (left: string, right: string): number => {
  const difference = slackTimestampTicks(left) - slackTimestampTicks(right);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
};
