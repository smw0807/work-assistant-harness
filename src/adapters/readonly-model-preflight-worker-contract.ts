import { fileURLToPath } from 'node:url';

/** 가짜 transport worker에는 고정된 하네스 모듈만 읽기 허용한다. 저장소·DB·snapshot 경로는 받지 않는다. */
export const readonlyModelPreflightWorkerLaunch = () => {
  const entry = fileURLToPath(new URL('../cli/readonly-model-preflight-worker.js', import.meta.url));
  const files = [
    entry,
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL('../policy/readonly-model-preflight-policy.js', import.meta.url)),
    fileURLToPath(new URL('../policy/readonly-model-preflight-protocol.js', import.meta.url)),
    fileURLToPath(new URL('../domain/readonly-model-preflight.js', import.meta.url)),
    fileURLToPath(new URL('../policy/readonly-investigation-policy.js', import.meta.url)),
    fileURLToPath(new URL('../domain/readonly-investigation.js', import.meta.url)),
    fileURLToPath(new URL('../domain/errors.js', import.meta.url)),
    fileURLToPath(new URL('../policy/readonly-transport-protocol.js', import.meta.url)),
    fileURLToPath(new URL('../domain/readonly-transport.js', import.meta.url)),
    fileURLToPath(new URL('../policy/read-policy.js', import.meta.url)),
    fileURLToPath(new URL('../policy/redaction.js', import.meta.url)),
  ];
  if (files.some((path) => /[*,]/u.test(path))) throw new Error('READONLY_MODEL_PREFLIGHT_UNSAFE_WORKER_PATH');
  return {
    entry,
    flags: ['--permission', ...files.map((path) => `--allow-fs-read=${path}`)],
    environment: { LANG: 'C.UTF-8', TZ: 'UTC' },
  };
};

export const assertReadonlyModelPreflightWorkerBoundary = (): void => {
  const { flags } = readonlyModelPreflightWorkerLaunch();
  if (JSON.stringify(process.execArgv) !== JSON.stringify(flags) || !process.connected
    || process.argv.length !== 2 || Object.keys(process.env).some((name) => !['LANG', 'TZ'].includes(name))
    || process.env['LANG'] !== 'C.UTF-8' || process.env['TZ'] !== 'UTC'
    || !process.permission || ['fs.write', 'child', 'worker', 'net', 'addons', 'wasi', 'inspector']
      .some((scope) => process.permission!.has(scope))) {
    throw new Error('READONLY_MODEL_PREFLIGHT_UNSAFE_WORKER_BOUNDARY');
  }
};
