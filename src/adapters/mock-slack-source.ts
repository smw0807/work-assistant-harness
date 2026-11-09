import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { HarnessError } from '../domain/errors.js';
import type { MessageSource } from '../ports/index.js';

const maxFixtureBytes = 131_072;
const maxFixtureEvents = 100;

export class MockSlackSource implements MessageSource {
  constructor(private readonly filePath: string) {}

  async read(): Promise<unknown[]> {
    let contents: string;
    try {
      const file = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxFixtureBytes) throw new HarnessError('FIXTURE_SIZE_LIMIT');
        const buffer = Buffer.alloc(maxFixtureBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const result = await file.read(buffer, length, buffer.length - length, length);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length > maxFixtureBytes) throw new HarnessError('FIXTURE_SIZE_LIMIT');
        contents = buffer.subarray(0, length).toString('utf8');
      } finally {
        await file.close();
      }
    } catch (error: unknown) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('FIXTURE_READ_FAILED');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw new HarnessError('FIXTURE_INVALID_JSON');
    }
    if (!Array.isArray(parsed) || parsed.length > maxFixtureEvents) throw new HarnessError('FIXTURE_INVALID_EVENTS');
    return parsed as unknown[];
  }
}
