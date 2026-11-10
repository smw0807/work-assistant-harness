import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createSandboxProbeSource } from '../src/adapters/sandbox-probes.js';
import type { SandboxProbeId, SandboxProbeInput } from '../src/domain/sandbox.js';

const syntheticInput: SandboxProbeInput = {
  workspaceRoot: '/tmp/synthetic-sandbox/workspace',
  protectedPaths: ['/tmp/synthetic-sandbox/protected/host-secret.txt'],
};

test('고정 probe는 실행 없이 Node module 문법을 검증한다', () => {
  for (const probe of ['boundary', 'pids', 'memory', 'timeout', 'output'] satisfies SandboxProbeId[]) {
    const source = createSandboxProbeSource(probe, syntheticInput, '24.11.1');
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: source, encoding: 'utf8', timeout: 2_000,
    });
    assert.equal(result.error, undefined, probe);
    assert.equal(result.status, 0, `${probe}: ${result.stderr}`);
  }
});

test('악성 경로와 버전 문자열은 JavaScript 조각 대신 JSON literal로 전달한다', () => {
  const adversarial = "\";process.exit(73);//\n`);${process.exit(74)};\\\u2028";
  const input: SandboxProbeInput = {
    workspaceRoot: `/tmp/${adversarial}`, protectedPaths: [`/tmp/${adversarial}`, '/tmp/한국어'],
  };
  const source = createSandboxProbeSource('boundary', input, adversarial);
  const configurationLine = source.split('\n').find((line) => line.startsWith('const configuration = '));
  assert.ok(configurationLine);
  assert.ok(configurationLine.startsWith('const configuration = '));
  const literal = configurationLine.slice('const configuration = '.length, -1);
  const configuration = JSON.parse(literal) as { workspaceRoot: string; protectedPaths: string[]; nodeVersion: string };
  assert.equal(configuration.workspaceRoot, input.workspaceRoot);
  assert.deepEqual(configuration.protectedPaths, input.protectedPaths);
  assert.equal(configuration.nodeVersion, adversarial);
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source, encoding: 'utf8', timeout: 2_000,
  });
  assert.equal(checked.error, undefined);
  assert.equal(checked.status, 0, checked.stderr);
});

test('등록되지 않은 probe는 실행 코드를 생성하지 않는다', () => {
  assert.throws(() => createSandboxProbeSource('shell' as SandboxProbeId, syntheticInput, '24.11.1'), {
    code: 'INVALID_SANDBOX_PROBE',
  });
});
