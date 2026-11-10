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

/** 저장소가 원본 메시지와 revision을 검증한 뒤 호출하는 별도 취소 경로다. */
export const invalidateTaskRequest = (task: Task, reason: 'REQUEST_CHANGED' | 'REQUEST_DELETED', at: string): Task => {
  return {
    ...task, status: 'CANCELLED', plan: null, report: null, failureCode: reason, updatedAt: at,
    history: task.status === 'CANCELLED' ? task.history : [...task.history, 'CANCELLED'],
  };
};
