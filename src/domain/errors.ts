export class HarnessError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'HarnessError';
  }
}

export class SlackListApiError extends HarnessError {
  constructor(code: string, public readonly method: 'slackLists.download.start' | 'slackLists.download.get') {
    super(code);
  }
}
