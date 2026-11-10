import { HarnessError } from '../domain/errors.js';
import {
  SANDBOX_LIMITS, type SandboxProbeId, type SandboxProbeInput,
} from '../domain/sandbox.js';

const createBoundaryProbe = (input: SandboxProbeInput, nodeVersion: string): string => {
  const configuration = JSON.stringify({ ...input, nodeVersion, limits: SANDBOX_LIMITS });
  return `const configuration = ${configuration};\n` + String.raw`
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';
import { Resolver } from 'node:dns/promises';

const deniesReadAndWrite = async (path) => {
  let readDenied = false;
  let writeDenied = false;
  try { await readFile(path); } catch { readDenied = true; }
  try { await (await open(path, 'r+')).close(); } catch { writeDenied = true; }
  return readDenied && writeDenied;
};

const deniesCreation = async (path) => {
  try { await writeFile(path, 'synthetic sandbox boundary probe\n'); return false; }
  catch { return true; }
};

const missing = async (path) => {
  try { await lstat(path); return false; } catch { return true; }
};

const deniesTcpConnection = () => new Promise((resolve) => {
  const socket = createConnection({ host: '198.51.100.1', port: 443 });
  let settled = false;
  const finish = (denied) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(denied);
  };
  const timer = setTimeout(() => finish(true), 500);
  socket.once('connect', () => finish(false));
  socket.once('error', () => finish(true));
});

const deniesDnsResolution = () => new Promise((resolve) => {
  const resolver = new Resolver();
  let settled = false;
  const finish = (denied) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolver.cancel();
    resolve(denied);
  };
  const timer = setTimeout(() => finish(true), 500);
  resolver.resolve4('sandbox-probe.invalid').then(() => finish(false), () => finish(true));
});

const checks = {};
try {
  await writeFile('/workspace/positive.txt', 'synthetic writable workspace\n');
  checks.workspaceWritable = await readFile('/workspace/positive.txt', 'utf8') === 'synthetic writable workspace\n';
} catch { checks.workspaceWritable = false; }
checks.protectedPathsDenied = (await Promise.all(configuration.protectedPaths.map(deniesReadAndWrite))).every(Boolean);
checks.hostWorkspacePathHidden = await deniesReadAndWrite(configuration.workspaceRoot + '/positive.txt');
checks.traversalDenied = await deniesReadAndWrite('/workspace/../protected/host-secret.txt');
checks.symlinkEscapeDenied = await deniesReadAndWrite('/workspace/escape');
checks.procRootPathsDenied = (await Promise.all(configuration.protectedPaths.map((path) => deniesReadAndWrite('/proc/1/root' + path)))).every(Boolean);
checks.rootFilesystemWriteDenied = (await Promise.all([
  deniesCreation('/tmp/harness-denied'), deniesCreation('/unapproved-root'),
  (async () => { try { await (await open('/etc/hostname', 'r+')).close(); return false; } catch { return true; } })(),
])).every(Boolean);
checks.dockerSocketsHidden = (await Promise.all(['/var/run/docker.sock', '/run/docker.sock'].map(missing))).every(Boolean);

const allowedEnvironment = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'LANG', 'NODE_OPTIONS', 'HOSTNAME']);
checks.environmentAllowlisted = Object.keys(process.env).every((name) => allowedEnvironment.has(name));
checks.hostSecretsAbsent = [
  'HARNESS_SANDBOX_FAKE_SECRET', 'SSH_AUTH_SOCK', 'DOCKER_HOST', 'TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN',
].every((name) => process.env[name] === undefined);
checks.fixedEnvironment = process.env.HOME === '/workspace' && process.env.LANG === 'C.UTF-8'
  && process.env.NODE_OPTIONS === '' && process.env.HOSTNAME === 'harness-probe';
checks.nonRootUser = process.getuid() === 1000 && process.geteuid() === 1000;
checks.nodeVersionPinned = process.version === 'v' + configuration.nodeVersion;

const status = await readFile('/proc/self/status', 'utf8');
checks.capabilitiesDropped = /^CapEff:\s*0+$/m.test(status);
checks.noNewPrivileges = /^NoNewPrivs:\s*1$/m.test(status);
checks.seccompEnabled = /^Seccomp:\s*2$/m.test(status);
const interfaces = networkInterfaces();
checks.loopbackOnlyInterfaces = Object.keys(interfaces).every((name) => name === 'lo')
  && Object.values(interfaces).flat().every((address) => address.internal);
checks.tcpDenied = checks.loopbackOnlyInterfaces && await deniesTcpConnection();
checks.dnsDenied = checks.loopbackOnlyInterfaces && await deniesDnsResolution();

const cgroupValue = async (name) => (await readFile('/sys/fs/cgroup/' + name, 'utf8')).trim();
checks.memoryLimit = await cgroupValue('memory.max') === String(configuration.limits.memoryBytes);
checks.swapDisabled = await cgroupValue('memory.swap.max') === '0';
checks.processLimit = await cgroupValue('pids.max') === String(configuration.limits.pids);
const [quota, period] = (await cgroupValue('cpu.max')).split(/\s+/).map(Number);
checks.cpuLimit = Number.isFinite(quota) && period > 0 && quota / period === configuration.limits.nanoCpus / 1_000_000_000;
console.log(JSON.stringify({ checks }));
`;
};

const processLimitProbe = String.raw`
import { spawn } from 'node:child_process';
const children = [];
let limited = false;
try {
  for (let index = 0; index < 80; index += 1) {
    const spawned = await new Promise((resolve) => {
      const child = spawn('/bin/sleep', ['10'], { stdio: 'ignore' });
      child.once('spawn', () => { children.push(child); resolve(true); });
      child.once('error', (error) => { limited = error.code === 'EAGAIN'; resolve(false); });
    });
    if (!spawned) break;
  }
} finally {
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill('SIGKILL');
  })));
}
console.log(JSON.stringify({ limited, count: children.length }));
`;

const memoryLimitProbe = String.raw`
const retained = [];
for (let index = 0; index < 32; index += 1) retained.push(Buffer.alloc(16 * 1024 * 1024, 1));
console.log(JSON.stringify({ unexpectedCompletion: true, allocatedBytes: retained.length * 16 * 1024 * 1024 }));
`;

const createDescendantProbe = (markerName: string): string => {
  const descendant = `import { writeFile } from 'node:fs/promises'; setTimeout(async () => { await writeFile(${JSON.stringify(`/workspace/${markerName}`)}, 'synthetic descendant survived\\n'); }, 3000);`;
  const readinessPath = `/workspace/${markerName.replace('-child.txt', '-ready.txt')}`;
  return `
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' });
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
await writeFile(${JSON.stringify(readinessPath)}, 'synthetic descendant spawned\\n');
child.unref();
setInterval(() => {}, 1000);
`;
};

const timeoutProbe = createDescendantProbe('timeout-child.txt');
const outputLimitProbe = createDescendantProbe('output-child.txt') + String.raw`
const payload = 'x'.repeat(4096);
const emit = () => {
  for (let index = 0; index < 8; index += 1) {
    process.stdout.write(payload);
    process.stderr.write(payload);
  }
};
setInterval(emit, 5);
emit();
`;

// 컨트롤러가 사라져도 고정 합성 진단 프로세스가 계속 실행되지 않게 한다.
const withDiagnosticWatchdog = (source: string): string => {
  return `setTimeout(() => process.exit(77), ${SANDBOX_LIMITS.probeWatchdogMs}).unref();\n` + source;
};

/** 합성 진단 코드만 생성한다. 저장소·모델 문자열을 실행 코드로 연결하지 않는다. */
export const createSandboxProbeSource = (
  probe: SandboxProbeId, input: SandboxProbeInput, nodeVersion: string,
): string => {
  switch (probe) {
    case 'boundary': return withDiagnosticWatchdog(createBoundaryProbe(input, nodeVersion));
    case 'pids': return withDiagnosticWatchdog(processLimitProbe);
    case 'memory': return withDiagnosticWatchdog(memoryLimitProbe);
    case 'timeout': return withDiagnosticWatchdog(timeoutProbe);
    case 'output': return withDiagnosticWatchdog(outputLimitProbe);
    default: throw new HarnessError('INVALID_SANDBOX_PROBE');
  }
};
