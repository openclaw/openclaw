// Control UI module implements ui types behavior.
export type ChatAttachment = {
  id: string;
  dataUrl?: string;
  previewUrl?: string;
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
};

export type ChatQueueSkillWorkshopRevision = {
  proposalId: string;
  agentId?: string;
};

export type ChatClarificationIssue = {
  key: string;
  label: string;
};

export type ChatClarificationRequest = {
  question: string;
  issues: ChatClarificationIssue[];
  suggestions?: string[];
};

export type ChatClarificationResponse = {
  bypass?: boolean;
  answer?: string;
};

export type PendingChatClarification = ChatClarificationRequest & {
  runId: string;
  sessionKey: string;
  originalMessage: string;
  agentId?: string;
  attachments?: ChatAttachment[];
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
  sendAttempts?: number;
  sendError?: string;
  sendRunId?: string;
  sendState?: "waiting-model" | "sending" | "waiting-reconnect" | "failed";
  sendSubmittedAtMs?: number;
  sendRequestStartedAtMs?: number;
  sessionKey?: string;
  agentId?: string;
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision;
  clarification?: ChatClarificationResponse;
};

export type ChatSessionRefreshTarget = {
  sessionKey: string;
  agentId?: string;
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
  payloadLocked: boolean;
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
