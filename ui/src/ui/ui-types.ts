export type ChatAttachment = {
  id: string;
  dataUrl: string;
  mimeType: string;
};

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
};

export const CRON_CHANNEL_LAST = "last";

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  notify: boolean;
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
  deliveryMode: "none" | "announce";
  deliveryChannel: string;
  deliveryTo: string;
  timeoutSeconds: string;
};
