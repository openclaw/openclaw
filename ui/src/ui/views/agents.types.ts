export type AgentsPanel =
  | "room"
  | "workflows"
  | "overview"
  | "files"
  | "tools"
  | "skills"
  | "channels"
  | "cron"
  | "self-improvement";

export type AgentWorkflowOrderState = Record<string, string[]>;

export type AgentWorkflowMapsState = {
  selectedRoomId: string | null;
  selectedStepId: string | null;
  orders: AgentWorkflowOrderState;
};
