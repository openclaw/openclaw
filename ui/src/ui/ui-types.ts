export type ChatAttachment = {
  id: string;
  dataUrl?: string;
  previewUrl?: string;
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
};

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  kind?: "queued" | "steered";
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
  localCommandArgs?: string;
  localCommandName?: string;
  pendingRunId?: string;
  // Carried through chat.send so server-side dedupe (`chat:${idempotencyKey}`)
  // keeps reconnect-replay safe. Set only for normal-send items that are
  // eligible for transport retry; local commands and steered entries omit it.
  idempotencyKey?: string;
  // Transport retries spent since the item was first dispatched. Bumped by
  // flushChatQueue when chat.send fails before the server ACK lands; capped at
  // CHAT_QUEUE_RETRY_BUDGET to bound silent loops on a wedged connection.
  retryCount?: number;
  // Set true once retryCount exceeds the budget so the queue surfaces a
  // failed-delivery indicator + manual retry instead of silently dropping.
  failed?: boolean;
};

export const CRON_CHANNEL_LAST = "last";

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  sessionKey: string;
  clearAgent: boolean;
  enabled: boolean;
  deleteAfterRun: boolean;
  scheduleKind: "at" | "every" | "cron";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  scheduleExact: boolean;
  staggerAmount: string;
  staggerUnit: "seconds" | "minutes";
  sessionTarget: "main" | "isolated" | "current" | `session:${string}`;
  wakeMode: "next-heartbeat" | "now";
  payloadKind: "systemEvent" | "agentTurn";
  payloadText: string;
  payloadModel: string;
  payloadThinking: string;
  payloadLightContext: boolean;
  deliveryMode: "none" | "announce" | "webhook";
  deliveryChannel: string;
  deliveryTo: string;
  deliveryAccountId: string;
  deliveryBestEffort: boolean;
  failureAlertMode: "inherit" | "disabled" | "custom";
  failureAlertAfter: string;
  failureAlertCooldownSeconds: string;
  failureAlertChannel: string;
  failureAlertTo: string;
  failureAlertDeliveryMode: "announce" | "webhook";
  failureAlertAccountId: string;
  timeoutSeconds: string;
};
