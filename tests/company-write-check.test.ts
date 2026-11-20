import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCompanyWrite } from '../src/application/check-company-write.js';
import { runCompanyWriteCommand } from '../src/cli/company-write.js';

test('company write CLI rejects source, draft, approval and duplicate options before reading anything', async () => {
  for (const args of [[], ['company-write-apply', '--data-dir', '/private/tmp/example'],
    ['company-write-check', '--source-root', '/not-an-allowed-source'],
    ['company-write-check', '--data-dir', '/private/tmp/example', '--draft', 'input.json'],
    ['company-write-check', '--data-dir', '/private/tmp/example', '--data-dir', '/private/tmp/another']]) {
    await assert.rejects(runCompanyWriteCommand(args), { code: 'COMPANY_WRITE_INVALID_ARGUMENTS' });
  }
});

test('isolated synthetic check switches branch then writes three files with durable one-use evidence',
  { timeout: 40_000, skip: process.platform !== 'darwin' }, async () => {
    const root = fs.mkdtempSync('/private/tmp/harness-write-check-'); fs.chmodSync(root, 0o700);
    try {
      const directory = join(root, 'check'), result = await checkCompanyWrite(directory);
      assert.equal(result.status, 'passed', JSON.stringify(result));
      assert.equal(result.osIsolation, true); assert.equal(result.branchBeforeFiles, true);
      assert.equal(result.selectedFilesMatch, true); assert.equal(result.indexPreserved, true);
      assert.equal(result.baseRefPreserved, true); assert.equal(result.unselectedFilePreserved, true);
      assert.equal(result.approvalConsumed, true); assert.equal(result.journalEntries, 9);
      assert.equal(result.actualCompanyAccess, false); assert.equal(result.actualCredentials, false);
      assert.equal(result.nativeCodex, false); assert.equal(result.modelCalls, 0);
      assert.equal(JSON.stringify(result).includes(directory), false);
      assert.equal(fs.statSync(join(directory, 'registration.json')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(join(directory, 'result.json')).mode & 0o777, 0o600);
      await assert.rejects(checkCompanyWrite(directory), { code: 'EEXIST' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
