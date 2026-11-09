import { HarnessError } from './errors.js';
import type { Task, TaskStatus } from './types.js';

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  RECEIVED: ['TRIAGED', 'BLOCKED', 'FAILED'],
  TRIAGED: ['ANALYZED', 'NEEDS_CLARIFICATION', 'BLOCKED', 'FAILED'],
  ANALYZED: ['REPORTED', 'AWAITING_APPROVAL', 'BLOCKED', 'FAILED'],
  REPORTED: [],
  NEEDS_CLARIFICATION: [],
  AWAITING_APPROVAL: [],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: [],
};

export const transitionTask = (task: Task, status: TaskStatus): Task => {
  if (!transitions[task.status].includes(status)) {
    throw new HarnessError('INVALID_STATE_TRANSITION');
  }
  return {
    ...task,
    status,
    updatedAt: new Date().toISOString(),
    history: [...task.history, status],
  };
};
