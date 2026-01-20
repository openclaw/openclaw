export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
};

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
  channel:
    | "last"
    | "whatsapp"
    | "telegram"
    | "discord"
    | "slack"
    | "signal"
    | "imessage"
    | "msteams"
    | "bluebubbles";
  to: string;
  timeoutSeconds: string;
  postToMainPrefix: string;
};
