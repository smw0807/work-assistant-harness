export class HarnessError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'HarnessError';
  }
}
