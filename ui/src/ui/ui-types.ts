export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
};

export const CRON_CHANNEL_LAST = "last";

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  scheduleKind: "at" | "every" | "cron";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payloadKind: "systemEvent" | "agentTurn";
  payloadText: string;
  deliver: boolean;
  channel: string;
  to: string;
  timeoutSeconds: string;
  postToMainPrefix: string;
};

export type GraphViewport = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export type GraphDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};
