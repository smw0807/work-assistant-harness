import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveCompanyApply, cancelCompanyApply, inspectCompanyApply, planCompanyApply, runCompanyApply,
  type CompanyApplySummary } from '../application/company-apply.js';
import { HarnessError } from '../domain/errors.js';
import { parseCompanyApplyDraft, parseCompanyApplyRegistration } from '../policy/company-apply.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { companyPathsOverlap } from './company-readonly-files.js';
import { acquireCompanyApplyControl, companyApplyPath, prepareCompanyApplyRuntime, readCompanyApplyPrivateJson } from './company-apply-files.js';

export const companyApplyUsage = [
  'pnpm harness company-apply-plan --registration <private-json> --draft <private-json> --data-dir <private-runtime>',
  'pnpm harness company-apply-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> --registration <private-json> --draft <private-json> --data-dir <private-runtime>',
  'pnpm harness company-apply-run --task <uuid> --plan-hash <sha256> --registration <private-json> --draft <private-json> --data-dir <private-runtime>',
  'pnpm harness company-apply-inspect --task <uuid> --data-dir <private-runtime>',
  'pnpm harness company-apply-cancel --task <uuid> --data-dir <private-runtime>',
].join('\n');
type Command = 'plan' | 'approve' | 'run' | 'inspect' | 'cancel';
const fail = (code = 'INVALID_ARGUMENTS'): never => { throw new HarnessError(`COMPANY_APPLY_${code}`); };
const parseArguments = (args: string[]): { command: Command; values: Map<string, string> } => {
  const commands = ['plan', 'approve', 'run', 'inspect', 'cancel'];
  if (!Array.isArray(args) || !args[0]?.startsWith('company-apply-')) fail();
  const command = args[0]!.slice('company-apply-'.length) as Command;
  if (!commands.includes(command)) fail();
  const required = ['--data-dir', ...(command !== 'plan' ? ['--task'] : []),
    ...(['plan', 'approve', 'run'].includes(command) ? ['--registration', '--draft'] : []),
    ...(['approve', 'run'].includes(command) ? ['--plan-hash'] : []), ...(command === 'approve' ? ['--expires-in-minutes'] : [])];
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!required.includes(name) || typeof value !== 'string' || !value || value.startsWith('--') || values.has(name)) fail();
    values.set(name, value!);
  }
  if (required.some(key => !values.has(key)) || values.has('--task') && !isReadonlyId(values.get('--task'))
    || values.has('--plan-hash') && !/^[a-f0-9]{64}$/u.test(values.get('--plan-hash')!)
    || values.has('--expires-in-minutes') && !/^(?:[1-9]|[1-5][0-9]|60)$/u.test(values.get('--expires-in-minutes')!)) fail();
  return { command, values };
};
const safeSummary = (value: CompanyApplySummary): CompanyApplySummary => {
  if (value.version !== 'company-apply-summary-v1' || !isReadonlyId(value.taskId) || !/^[a-f0-9]{64}$/u.test(value.planHash)
    || !['AWAITING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED', 'EXPIRED', 'UNKNOWN'].includes(value.status)
    || !Number.isSafeInteger(value.changeCount) || value.changeCount < 1 || value.changeCount > 8
    || typeof value.approvalConsumed !== 'boolean' || value.checks !== 'not_run' || value.transmissionAllowed !== false) fail('INVALID_RESULT');
  return { version: 'company-apply-summary-v1', taskId: value.taskId, planHash: value.planHash, status: value.status,
    changeCount: value.changeCount, approvalConsumed: value.approvalConsumed, checks: 'not_run', transmissionAllowed: false };
};

/** Registration and draft files are needed only for explicit plan, approve and run commands. */
export const runCompanyApplyCommand = async (args: string[]): Promise<void> => {
  let release: (() => void) | null = null;
  const previousUmask = process.umask(0o077);
  try {
    const { command, values } = parseArguments(args), directory = companyApplyPath(values.get('--data-dir'));
    const harness = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
    const registrationPath = values.has('--registration') ? companyApplyPath(values.get('--registration')) : null;
    const draftPath = values.has('--draft') ? companyApplyPath(values.get('--draft')) : null;
    if (companyPathsOverlap(directory, harness) || [registrationPath, draftPath].some(path => path
      && (companyPathsOverlap(path, harness) || companyPathsOverlap(path, directory)))) fail('UNSAFE_PATH');
    const registrationFile = registrationPath ? await readCompanyApplyPrivateJson(registrationPath, 'registration') : null;
    const draftFile = draftPath ? await readCompanyApplyPrivateJson(draftPath, 'draft') : null;
    const registration = registrationFile ? parseCompanyApplyRegistration(registrationFile.value) : null;
    const draft = registration && draftFile ? parseCompanyApplyDraft(draftFile.value, registration) : null;
    if (registration && [directory, harness, registrationPath, draftPath].some(path => path
      && companyPathsOverlap(path, registration.sourceRoot))) fail('UNSAFE_PATH');
    const guard = await prepareCompanyApplyRuntime(directory, command === 'plan');
    release = acquireCompanyApplyControl(directory, command === 'plan');
    await guard(); await registrationFile?.guard(); await draftFile?.guard();
    const uid = process.getuid?.(); if (uid === undefined) fail('INVALID_OWNER');
    const context = { ownerId: `os-user:${uid}`, now: new Date() }, taskId = values.get('--task')!;
    let result: CompanyApplySummary;
    if (command === 'plan') result = await planCompanyApply({ registration: registration!, draft: draft!, directory, context });
    else if (command === 'approve') result = await approveCompanyApply({ taskId, planHash: values.get('--plan-hash')!,
      expiresInMinutes: Number(values.get('--expires-in-minutes')), registration: registration!, draft: draft!, directory, context });
    else if (command === 'run') result = await runCompanyApply({ taskId, planHash: values.get('--plan-hash')!,
      registration: registration!, draft: draft!, directory, context });
    else if (command === 'inspect') result = await inspectCompanyApply({ taskId, directory, context });
    else result = await cancelCompanyApply({ taskId, directory, context });
    await guard(); await registrationFile?.guard(); await draftFile?.guard();
    const summary = safeSummary(result);
    release(); release = null;
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (command === 'run' && ['FAILED', 'UNKNOWN'].includes(summary.status)) process.exitCode = 1;
  } catch (error) {
    if (error instanceof HarnessError && /^COMPANY_APPLY_[A-Z_]{1,60}$/u.test(error.code)) throw new HarnessError(error.code);
    throw new HarnessError('COMPANY_APPLY_COMMAND_FAILED');
  } finally {
    try { release?.(); } finally { process.umask(previousUmask); }
  }
};
