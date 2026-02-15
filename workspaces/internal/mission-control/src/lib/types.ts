export type Priority = 'P1' | 'P2' | 'P3';
export type TaskStatus = 'queued' | 'running' | 'blocked' | 'review' | 'done';
export type SlaRisk = 'green' | 'amber' | 'red';

export type Task = {
  id: string;
  title: string;
  project?: string;
  priority: Priority;
  status: TaskStatus;
  ownerAgent?: string;
  ownerSubAgent?: string;
  node?: string;
  sourceChannel?: string;

  createdAt: string;
  startedAt?: string;
  dueAt?: string;
  etaMinutes?: number;

  blocker?: string;
  nextAction?: string;
  lastUpdateAt: string;
};

export type TaskWithDerived = Task & {
  slaRisk: SlaRisk;
  isOverdue: boolean;
  blockedMinutes?: number;
};
