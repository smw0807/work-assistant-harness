import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import git from 'isomorphic-git';
import { createCompanyGitRangeUnitSource } from '../src/adapters/company-git-range-unit-source.js';
import { HarnessError } from '../src/domain/errors.js';
import { createCompanyGitRangeSourceFailure, extractCompanyGitRangeSourceFailureReason,
  isCompanyGitRangeSourceFailureReason, type CompanyGitRangeSourceFailureReason } from '../src/policy/company-git-range-source-failure.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const reasons = ['head_ref', 'delta_base', 'object_lookup', 'object_type', 'tree_selection',
  'source_size', 'safe_view', 'excerpt', 'unexpected'] as const;
const request = (fixture: Awaited<ReturnType<typeof createCompanyReadonlyV3Fixture>>) => ({
  version: 'company-git-range-source-v2', profileHash: fixture.registration.gitProfileHash,
  guardPolicyHash: fixture.registration.guardPolicyHash, sourceRoot: fixture.root,
  baseCommit: fixture.baseCommit, selectedPaths: [...fixture.selectedPaths].sort(),
});
const rejectsWith = (operation: () => unknown, reason: CompanyGitRangeSourceFailureReason): void => {
  assert.throws(operation, error => {
    assert.equal((error as HarnessError).code, 'COMPANY_GIT_RANGE_INVALID_SOURCE');
    assert.equal(extractCompanyGitRangeSourceFailureReason(error), reason);
    assert.equal(Object.hasOwn(error as object, 'sourceFailureReason'), false);
    return true;
  });
};

test('source failure diagnostics use issued identities and finite values without changing the public code', () => {
  for (const reason of reasons) {
    assert.equal(isCompanyGitRangeSourceFailureReason(reason), true);
    const error = createCompanyGitRangeSourceFailure(reason);
    assert.equal(error.code, 'COMPANY_GIT_RANGE_INVALID_SOURCE');
    assert.equal(error.message, 'COMPANY_GIT_RANGE_INVALID_SOURCE');
    assert.equal(extractCompanyGitRangeSourceFailureReason(error), reason);
    assert.equal(extractCompanyGitRangeSourceFailureReason(new HarnessError(error.code)), null);
    assert.equal(JSON.stringify(error).includes(reason), false);
  }
  for (const reason of [undefined, null, '/synthetic/private/source.ts', {}, 'other']) {
    assert.equal(isCompanyGitRangeSourceFailureReason(reason), false);
    const error = createCompanyGitRangeSourceFailure(reason as CompanyGitRangeSourceFailureReason);
    assert.equal(error.code, 'COMPANY_GIT_RANGE_INVALID_SOURCE');
    assert.equal(extractCompanyGitRangeSourceFailureReason(error), null);
  }
});

test('source diagnostic extraction never inspects foreign error properties or proxy hooks', () => {
  let accesses = 0;
  const hostile = (): never => { accesses++; throw new Error('SYNTHETIC_PRIVATE_DETAIL'); };
  const genuine = createCompanyGitRangeSourceFailure('head_ref');
  const foreign = Object.defineProperty({}, 'sourceFailureReason', { get: hostile });
  const proxy = new Proxy(genuine, { get: hostile, getPrototypeOf: hostile, ownKeys: hostile });
  const revoked = Proxy.revocable(genuine, {}); revoked.revoke();
  for (const value of [foreign, proxy, revoked.proxy, { ...genuine, sourceFailureReason: 'head_ref' },
    new HarnessError('COMPANY_GIT_RANGE_LIMIT'), null, 'head_ref']) assert.equal(extractCompanyGitRangeSourceFailureReason(value), null);
  assert.equal(accesses, 0);
});

for (const reason of ['head_ref', 'object_lookup', 'object_type', 'tree_selection'] as const) {
  test(`the synthetic reader identifies ${reason} without returning source data or changing its fixture`, async context => {
    const fixture = await createCompanyReadonlyV3Fixture(context), input = request(fixture);
    if (reason === 'head_ref') fs.writeFileSync(join(fixture.root, '.git/HEAD'), 'invalid synthetic reference\n');
    if (reason === 'object_lookup' || reason === 'object_type') {
      input.baseCommit = reason === 'object_lookup' ? '0'.repeat(40) : fixture.mainOid;
      fs.writeFileSync(join(fixture.root, '.git/HEAD'), `${input.baseCommit}\n`);
    }
    if (reason === 'tree_selection') {
      input.selectedPaths = ['src/missing.ts'];
      fs.writeFileSync(join(fixture.root, 'src/missing.ts'), '// synthetic untracked file\n');
    }
    const before = fixture.snapshot(), source = createCompanyGitRangeUnitSource(input, () => 0);
    try {
      rejectsWith(() => source.inspect(), reason);
      assert.equal(source.snapshot().phase, 'failed');
      assert.equal(source.snapshot().openDescriptors, 0);
      assert.equal(source.snapshot().liveMemoryBytes, 0);
      assert.equal(fixture.snapshot(), before);
    } finally { source.close(); }
  });
}

test('the selected blob size rejection keeps the original file limit and a fixed diagnostic', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), filepath = 'src/main.ts';
  fs.writeFileSync(join(fixture.root, filepath), `${'x'.repeat(65536)}\n`);
  await git.add({ fs, dir: fixture.root, filepath });
  const author = { name: 'Synthetic Source', email: 'source@example.invalid', timestamp: 1704067200, timezoneOffset: 0 };
  const baseCommit = await git.commit({ fs, dir: fixture.root, author, committer: author, message: 'Synthetic size rejection' });
  const before = fixture.snapshot(), source = createCompanyGitRangeUnitSource({ ...request(fixture), baseCommit }, () => 0);
  try {
    rejectsWith(() => source.inspect(), 'source_size');
    assert.equal(source.snapshot().openDescriptors, 0); assert.equal(source.snapshot().liveMemoryBytes, 0);
    assert.equal(fixture.snapshot(), before);
  } finally { source.close(); }
});

test('an unexpected synthetic clock exception exposes no original message', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), before = fixture.snapshot();
  rejectsWith(() => createCompanyGitRangeUnitSource(request(fixture), () => { throw new Error('SYNTHETIC_PRIVATE_CLOCK'); }), 'unexpected');
  assert.equal(fixture.snapshot(), before);
});
