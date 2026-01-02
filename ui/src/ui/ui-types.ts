export type TelegramForm = {
  token: string;
  requireMention: boolean;
  allowFrom: string;
  proxy: string;
  webhookUrl: string;
  webhookSecret: string;
  webhookPath: string;
};

export type DiscordForm = {
  enabled: boolean;
  token: string;
  allowFrom: string;
  groupEnabled: boolean;
  groupChannels: string;
  mediaMaxMb: string;
  historyLimit: string;
  enableReactions: boolean;
  slashEnabled: boolean;
  slashName: string;
  slashSessionPrefix: string;
  slashEphemeral: boolean;
};

export type SignalForm = {
  enabled: boolean;
  account: string;
  httpUrl: string;
  httpHost: string;
  httpPort: string;
  cliPath: string;
  autoStart: boolean;
  receiveMode: "on-start" | "manual" | "";
  ignoreAttachments: boolean;
  ignoreStories: boolean;
  sendReadReceipts: boolean;
  allowFrom: string;
  mediaMaxMb: string;
};

export type IMessageForm = {
  enabled: boolean;
  cliPath: string;
  dbPath: string;
  service: "auto" | "imessage" | "sms";
  region: string;
  allowFrom: string;
  includeAttachments: boolean;
  mediaMaxMb: string;
};

export type CronFormState = {
  name: string;
  description: string;
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
  channel: "last" | "whatsapp" | "telegram";
  to: string;
  timeoutSeconds: string;
  postToMainPrefix: string;
};
