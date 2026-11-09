import { HarnessError } from '../domain/errors.js';
import type { ApprovalPort, ExecutionPort } from '../ports/index.js';

export class DeniedApproval implements ApprovalPort {
  approve(_taskId: string, _planHash: string): never {
    throw new HarnessError('APPROVAL_NOT_IMPLEMENTED');
  }
}

export class DeniedExecution implements ExecutionPort {
  execute(_taskId: string): never {
    throw new HarnessError('EXECUTION_DISABLED');
  }
}
