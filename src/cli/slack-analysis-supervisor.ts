import { spawn, type ChildProcess } from 'node:child_process';
import { HarnessError } from '../domain/errors.js';

const shutdownGraceMs = 6500;
const readyTimeoutMs = 15_000;
interface SupervisedChild { process: ChildProcess; closed: boolean }

/** The trusted CLI supplies fixed workers. Slack credentials are confined to the receiver environment. */
export const runSlackAnalysisPair = async (
  executable: string,
  receiverArgs: string[],
  analysisArgs: string[],
  sourceRoot: string,
  receiverEnvironment: Record<string, string>,
): Promise<void> => new Promise((resolveRun, reject) => {
  const children: SupervisedChild[] = [];
  let launching = true;
  let stopping = false;
  let userStopped = false;
  let failed = false;
  let finished = false;
  let receiverStarted = false;
  let killTimer: NodeJS.Timeout | undefined;
  let readyTimer: NodeJS.Timeout | undefined;

  const finishIfClosed = (): void => {
    if (finished || launching || children.some(child => !child.closed)) return;
    finished = true;
    if (killTimer) clearTimeout(killTimer);
    if (readyTimer) clearTimeout(readyTimer);
    process.off('SIGINT', stopFromUser);
    process.off('SIGTERM', stopFromUser);
    if (failed) reject(new HarnessError('SLACK_ANALYSIS_PAIR_FAILED'));
    else resolveRun();
  };
  const signalChildren = (signal: NodeJS.Signals): void => {
    for (const child of children) {
      if (child.closed) continue;
      try { child.process.kill(signal); } catch { failed = true; }
    }
  };
  const stopChildren = (): void => {
    if (stopping) return;
    stopping = true;
    if (readyTimer) clearTimeout(readyTimer);
    signalChildren('SIGTERM');
    killTimer = setTimeout(() => {
      if (children.some(child => !child.closed)) {
        if (!userStopped) failed = true;
        signalChildren('SIGKILL');
      }
    }, shutdownGraceMs);
    finishIfClosed();
  };
  const stopFromUser = (): void => { userStopped = true; stopChildren(); };

  const startChild = (args: string[], environment: Record<string, string>): SupervisedChild | undefined => {
    if (stopping) return undefined;
    const child: SupervisedChild = {
      process: spawn(executable, args, { cwd: sourceRoot, env: environment, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }),
      closed: false,
    };
    children.push(child);
    child.process.on('error', () => { failed = true; stopChildren(); });
    child.process.once('close', (code, signal) => {
      child.closed = true;
      if (!stopping && (!receiverStarted || code !== 0 || signal !== null)) failed = true;
      stopChildren();
      finishIfClosed();
    });
    return child;
  };

  process.on('SIGINT', stopFromUser);
  process.on('SIGTERM', stopFromUser);
  try {
    // Copy an allowlist even for the receiver so callers cannot accidentally forward ambient execution options.
    const receiverEnv: Record<string, string> = { LANG: 'C.UTF-8', TZ: 'UTC' };
    for (const key of ['SLACK_APP_TOKEN', 'SLACK_WEB_TOKEN', 'SLACK_LIST_USER_TOKEN']) {
      if (receiverEnvironment[key] !== undefined) receiverEnv[key] = receiverEnvironment[key]!;
    }
    const analysis = startChild(analysisArgs, { LANG: 'C.UTF-8', TZ: 'UTC', PATH: '/usr/bin:/bin' });
    readyTimer = setTimeout(() => { failed = true; stopChildren(); }, readyTimeoutMs);
    analysis?.process.on('message', (message: unknown) => {
      if (stopping || receiverStarted) return;
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).length !== 1 || !Object.hasOwn(message, 'ready') || (message as { ready: unknown }).ready !== true) {
        failed = true;
        stopChildren();
        return;
      }
      if (readyTimer) clearTimeout(readyTimer);
      try {
        startChild(receiverArgs, receiverEnv);
        receiverStarted = true;
      } catch { failed = true; stopChildren(); }
    });
  } catch {
    failed = true;
    stopChildren();
  } finally {
    launching = false;
    finishIfClosed();
  }
});
