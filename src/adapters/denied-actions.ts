import { HarnessError } from '../domain/errors.js';
import type { ApprovalPort, ExecutionPort } from '../ports/index.js';
import type { ApprovalContext, ApprovalRequest } from '../domain/approval.js';

export class DeniedApproval implements ApprovalPort {
  approve(_request: ApprovalRequest, _context: ApprovalContext): never {
    throw new HarnessError('APPROVAL_NOT_IMPLEMENTED');
  }
}

export class DeniedExecution implements ExecutionPort {
  execute(_taskId: string): never {
    throw new HarnessError('EXECUTION_DISABLED');
  }
}
