export type TaskBoardLane = "active" | "scheduled";
export type TaskBoardStatus =
  | "queued"
  | "in_progress"
  | "waiting"
  | "blocked"
  | "paused"
  | "done"
  | "disabled"
  | "error";
export type TaskBoardHealth = "healthy" | "warning" | "stale" | "error";
export type TaskBoardProgressSource = "explicit" | "derived" | "estimated" | null;

export type TaskBoardCardVM = {
  id: string;
  lane: TaskBoardLane;
  title: string;
  owner: string;
  status: TaskBoardStatus;
  health: TaskBoardHealth;
  progressPercent: number | null;
  progressSource: TaskBoardProgressSource;
  startedAt: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runningForSec: number | null;
  waitingForSec: number | null;
  tokenUsage: {
    value: number | null;
    window: string | null;
    source: string | null;
  };
  summary: string | null;
  blocker: string | null;
  decisionNeeded: boolean;
  recentResult: string | null;
  enabled: boolean | null;
  sourceOfTruth: string[];
};

export type TaskBoardCardsByLane = {
  active: TaskBoardCardVM[];
  scheduled: TaskBoardCardVM[];
};

export function splitTaskBoardCardsByLane(cards: TaskBoardCardVM[]): TaskBoardCardsByLane {
  return {
    active: cards.filter((card) => card.lane === "active"),
    scheduled: cards.filter((card) => card.lane === "scheduled"),
  };
}
