import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { SyntheticCompanyChangePlan, SyntheticCompanyChangeRequest } from '../domain/synthetic-company-change.js';
import type { SyntheticCompanyChangeObservation } from '../domain/synthetic-company-change-recovery.js';
import { HarnessError } from '../domain/errors.js';
import type { RecoverableSyntheticCompanyChangeStore } from '../ports/synthetic-company-change.js';
import { copyCompanyChangeData } from '../policy/company-change.js';
import { assertSyntheticCompanyChangeContext, assertSyntheticCompanyChangeRequest } from '../policy/synthetic-company-change.js';
import { readonlyExactKeys } from '../policy/readonly-investigation-policy.js';

const fail: (suffix: string) => never = suffix => { throw new HarnessError(`SYNTHETIC_COMPANY_CHANGE_${suffix}`); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Observation is evidence about remaining bytes, never permission to resume or claim APPLIED. */
const validateObservation = (observation: SyntheticCompanyChangeObservation, plan: SyntheticCompanyChangePlan): void => {
  if (!readonlyExactKeys(observation, ['version', 'taskId', 'planHash', 'branch', 'files', 'indexPreserved', 'basePreserved', 'residuals', 'complete'])
    || observation.version !== 'synthetic-company-change-observation-v1' || observation.taskId !== plan.id
    || observation.planHash !== plan.planHash || typeof observation.complete !== 'boolean'
    || !Array.isArray(observation.files) || observation.files.length !== plan.changes.length
    || Object.keys(observation.files).length !== observation.files.length) fail('INVALID_OBSERVATION');
  if (observation.complete) {
    if (!['base', 'target', 'other'].includes(observation.branch) || typeof observation.indexPreserved !== 'boolean'
      || typeof observation.basePreserved !== 'boolean' || !Number.isSafeInteger(observation.residuals)
      || observation.residuals! < 0 || observation.residuals! > 256) fail('INVALID_OBSERVATION');
  } else if (observation.branch !== 'unknown' || observation.indexPreserved !== null || observation.basePreserved !== null
    || observation.residuals !== null) fail('INVALID_OBSERVATION');
  for (const [index, file] of observation.files.entries()) {
    const change = plan.changes[index]!;
    if (!readonlyExactKeys(file, ['path', 'state', 'hash']) || file.path !== change.path
      || !['before', 'after', 'absent', 'other', 'unsafe'].includes(file.state)
      || (['before', 'after', 'other'].includes(file.state) ? !hash(file.hash) : file.hash !== null)
      || file.state === 'before' && file.hash !== change.beforeHash
      || file.state === 'after' && file.hash !== change.afterHash
      || file.state === 'other' && [change.beforeHash, change.afterHash].includes(file.hash)
      || (observation.complete ? file.state === 'unsafe' : file.state !== 'unsafe')) fail('INVALID_OBSERVATION');
  }
};

/** The trusted CLI holds its exclusive runtime control lease throughout this operation. */
export const recoverSyntheticCompanyChange = async (
  store: RecoverableSyntheticCompanyChangeStore,
  workspace: { observeRecovery(plan: SyntheticCompanyChangePlan): Promise<SyntheticCompanyChangeObservation> },
  input: SyntheticCompanyChangeRequest,
  context: () => ReadonlyContext = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() }),
) => {
  assertSyntheticCompanyChangeRequest(input);
  const request = copyCompanyChangeData(input), beforeContext = context();
  assertSyntheticCompanyChangeContext(beforeContext);
  const before = store.inspect(request.taskId, beforeContext);
  if (before.plan.planHash !== request.planHash) fail('PLAN_MISMATCH');
  if (before.status !== 'APPLYING'
    && !(before.status === 'FAILED' && before.failureCode === 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED')) fail('RECOVERY_UNAVAILABLE');
  const observation = await workspace.observeRecovery(before.plan);
  validateObservation(observation, before.plan);
  const afterContext = context(); assertSyntheticCompanyChangeContext(afterContext);
  const snapshot = store.recover(request, afterContext);
  return { snapshot, observation: copyCompanyChangeData(observation) };
};
