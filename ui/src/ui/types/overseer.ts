/**
 * Local type definitions for overseer protocol.
 * These mirror the types from src/gateway/protocol/schema/overseer.ts
 * but are local to the UI package to avoid cross-package imports.
 */

export type OverseerGoalSummary = {
  goalId: string;
  title: string;
  status: string;
  priority: string;
  updatedAt: number;
  tags: string[];
};

export type OverseerAssignmentSummary = {
  assignmentId: string;
  goalId: string;
  workNodeId: string;
  status: string;
  agentId?: string;
  lastDispatchAt?: number;
  lastObservedActivityAt?: number;
  retryCount?: number;
  backoffUntil?: number;
};

export type OverseerStatusResult = {
  ts: number;
  goals: OverseerGoalSummary[];
  stalledAssignments: OverseerAssignmentSummary[];
};

export type OverseerPlanNode = {
  id: string;
  parentId?: string;
  path?: string;
  name: string;
  objective?: string;
  expectedOutcome?: string;
  acceptanceCriteria?: string[];
  definitionOfDone?: string;
  dependsOn?: string[];
  blocks?: string[];
  suggestedAgentId?: string;
  suggestedAgentType?: string;
  requiredTools?: string[];
  estimatedEffort?: string;
  riskLevel?: string;
  status: string;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
};

export type OverseerSubtask = OverseerPlanNode;

export type OverseerTask = OverseerPlanNode & {
  subtasks: OverseerSubtask[];
};

export type OverseerPhase = OverseerPlanNode & {
  tasks: OverseerTask[];
};

export type OverseerPlan = {
  planVersion: number;
  phases: OverseerPhase[];
};

export type OverseerGoalDetail = {
  goalId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  priority: string;
  tags: string[];
  problemStatement: string;
  successCriteria: string[];
  nonGoals: string[];
  constraints?: string[];
  owner?: string;
  stakeholders?: string[];
  repoContextSnapshot?: string;
  assumptions?: string[];
  risks?: Array<{
    risk: string;
    impact?: string;
    mitigation?: string;
  }>;
  plan?: OverseerPlan;
};

export type OverseerAssignmentDetail = {
  assignmentId: string;
  goalId: string;
  workNodeId: string;
  status: string;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  createdAt: number;
  updatedAt: number;
  lastDispatchAt?: number;
  lastObservedActivityAt?: number;
  expectedNextUpdateAt?: number;
  idleAfterMs?: number;
  retryCount?: number;
  lastRetryAt?: number;
  backoffUntil?: number;
  recoveryPolicy?: string;
  blockedReason?: string;
};

export type OverseerCrystallization = {
  crystallizationId: string;
  goalId: string;
  workNodeId?: string;
  summary?: string;
  currentState?: string;
  decisions?: string[];
  nextActions?: string[];
  openQuestions?: string[];
  knownBlockers?: string[];
  evidence?: {
    filesTouched?: string[];
    commandsRun?: string[];
    testsRun?: string[];
    commits?: string[];
    prs?: string[];
    issues?: string[];
    externalRefs?: string[];
  };
  createdAt: number;
};

export type OverseerEvent = {
  ts: number;
  type: string;
  goalId?: string;
  assignmentId?: string;
  workNodeId?: string;
};

export type OverseerGoalStatusResult = {
  ts: number;
  goal?: OverseerGoalDetail;
  assignments: OverseerAssignmentDetail[];
  crystallizations: OverseerCrystallization[];
  events: OverseerEvent[];
};
