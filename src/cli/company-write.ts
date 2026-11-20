import { checkCompanyWrite } from '../application/check-company-write.js';
import { HarnessError } from '../domain/errors.js';

export const companyWriteUsage = 'pnpm harness company-write-check --data-dir <new-directory-inside-private-tmp-parent>';
export const runCompanyWriteCommand = async (args: string[]): Promise<void> => {
  if (args.length !== 3 || args[0] !== 'company-write-check' || args[1] !== '--data-dir' || !args[2]) {
    throw new HarnessError('COMPANY_WRITE_INVALID_ARGUMENTS');
  }
  process.umask(0o077);
  const result = await checkCompanyWrite(args[2]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
};
