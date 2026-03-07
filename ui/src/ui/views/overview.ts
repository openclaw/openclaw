import { html, nothing, svg } from "lit";
import type { EventLogEntry } from "../app-events.ts";
import type { DashboardTimelinePoint } from "../controllers/dashboard-timeline.ts";
import type { DashboardIncidentRecord, DashboardSummaryResult } from "../controllers/dashboard.ts";
import type { DevicePairingList } from "../controllers/devices.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../controllers/exec-approval.ts";
import type {
  MissionNodeActionKind,
  MissionNodeActionResult,
} from "../controllers/mission-control.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import type { Tab } from "../navigation.ts";
import type { UiSettings } from "../storage.ts";
import type {
  ChannelsStatusSnapshot,
  CostUsageSummary,
  CronJob,
  CronStatus,
  LogEntry,
  LogLevel,
  PresenceEntry,
  SessionsListResult,
  SessionsUsageResult,
} from "../types.ts";
import { parseAgentSessionKey } from "../../../../src/routing/session-key.js";
import { clampText, formatDurationHuman, formatRelativeTimestamp } from "../format.ts";
import { formatNextRun } from "../presenter.ts";

type Tone = "ok" | "warn" | "danger" | "info" | "muted";

type StatusHeartbeatAgentLike = {
  agentId?: string;
  enabled?: boolean;
  every?: string;
  everyMs?: number | null;
};

type StatusSummaryLike = {
  heartbeat?: {
    defaultAgentId?: string;
    agents?: StatusHeartbeatAgentLike[];
  };
  queuedSystemEvents?: string[];
  sessions?: {
    defaults?: { model?: string | null; contextTokens?: number | null };
    count?: number;
  };
} & Record<string, unknown>;

type HealthChannelSummaryLike = {
  accountId?: string;
  configured?: boolean;
  linked?: boolean;
  probe?: Record<string, unknown> | null;
  accounts?: Record<string, HealthChannelSummaryLike>;
} & Record<string, unknown>;

type HealthSummaryLike = {
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  channels?: Record<string, HealthChannelSummaryLike>;
} & Record<string, unknown>;

type MissionAlert = {
  tone: Tone;
  title: string;
  detail: string;
};

type MissionFeedItem = {
  id: string;
  tone: Tone;
  source: "event" | "log";
  ts: number;
  label: string;
  title: string;
  detail: string;
};

type MissionChannelCard = {
  id: string;
  label: string;
  tone: Tone;
  summary: string;
  detail: string;
  accountCount: number;
  lastActivityAt: number | null;
};

type UsageSnapshot = {
  totalCost: number | null;
  totalTokens: number | null;
  sessions: number;
  messages: number;
  errors: number;
  topAgent: string | null;
  topTool: string | null;
  topModel: string | null;
  latencyP95Ms: number | null;
};

type MissionIncident = {
  id: string;
  tone: Tone;
  title: string;
  detail: string;
  status?: "open" | "acked" | "resolved";
  backendManaged?: boolean;
  logQuery?: string;
  sessionKey?: string;
  agentId?: string;
  channelId?: string;
  nodeId?: string;
  actionLabel?: string;
  actionTab?: Tab;
};

type MissionNodeCard = {
  nodeId: string;
  label: string;
  detail: string;
  commands: string[];
  connected: boolean;
  paired: boolean;
  tone: Tone;
};

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  cronStatus: CronStatus | null;
  cronJobs: CronJob[];
  cronError: string | null;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  lastChannelsRefresh: number | null;
  debugStatus: Record<string, unknown> | null;
  debugHealth: Record<string, unknown> | null;
  debugHeartbeat: unknown;
  logsEntries: LogEntry[];
  logsError: string | null;
  logsLastFetchAt: number | null;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  devicesList: DevicePairingList | null;
  devicesError: string | null;
  devicesLoading: boolean;
  dashboardSummary: DashboardSummaryResult | null;
  dashboardError: string | null;
  dashboardLoading: boolean;
  dashboardTimeline: DashboardTimelinePoint[];
  nodes: Array<Record<string, unknown>>;
  missionNodeBusyById: Record<string, MissionNodeActionKind | "approval" | null>;
  missionNodeResult: MissionNodeActionResult | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  cronBusy: boolean;
  nodesCount: number;
  eventLog: EventLogEntry[];
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onNavigate: (tab: Tab) => void;
  onOpenSession: (sessionKey: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
  onResolveExecApproval: (id: string, decision: ExecApprovalDecision) => Promise<void>;
  onApproveDevice: (requestId: string) => Promise<void>;
  onRejectDevice: (requestId: string) => Promise<void>;
  onRunCronJob: (jobId: string) => Promise<void>;
  onRefreshSecurityAudit: () => Promise<void>;
  onAckIncident: (incidentId: string) => Promise<boolean>;
  onResolveIncident: (incidentId: string) => Promise<boolean>;
  onDescribeNode: (nodeId: string) => Promise<void>;
  onProbeNode: (nodeId: string) => Promise<void>;
  onRunNodeDoctor: (nodeId: string) => Promise<void>;
  onOpenLogsQuery: (query: string) => Promise<void>;
  onFocusAgent: (agentId: string) => void;
  onFocusChannel: (channelId: string) => void;
  onFocusNode: (nodeId: string) => void;
};

const RECENT_ACTIVITY_MS = 10 * 60 * 1000;
const HOT_SESSION_CONTEXT_THRESHOLD = 0.72;
const numberFormatter = new Intl.NumberFormat("en-US");
const compactNumberFormatter = new Intl.NumberFormat("en-US", { notation: "compact" });
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asStatusSummary(value: unknown): StatusSummaryLike | null {
  return asRecord(value) as StatusSummaryLike | null;
}

function asHealthSummary(value: unknown): HealthSummaryLike | null {
  return asRecord(value) as HealthSummaryLike | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringifyPayload(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toneClass(tone: Tone): string {
  return `mission-tone-${tone}`;
}

function formatCount(value: number | null | undefined): string {
  if (value == null) {
    return "n/a";
  }
  return numberFormatter.format(value);
}

function formatCompactCount(value: number | null | undefined): string {
  if (value == null) {
    return "n/a";
  }
  return compactNumberFormatter.format(value);
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }
  return currencyFormatter.format(value);
}

function formatRelativeOrNa(ms: number | null | undefined): string {
  if (!ms) {
    return "n/a";
  }
  return formatRelativeTimestamp(ms);
}

function formatLastActivity(ms: number | null): string {
  if (!ms) {
    return "No recent activity";
  }
  return `Last activity ${formatRelativeTimestamp(ms)}`;
}

function hasRecentActivity(ms: number | null | undefined): boolean {
  return typeof ms === "number" && Date.now() - ms <= RECENT_ACTIVITY_MS;
}

function resolveLogTimestamp(entry: LogEntry, index: number): number {
  if (entry.time) {
    const parsed = Date.parse(entry.time);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now() - index * 1000;
}

function resolveLogTone(level: LogLevel | null | undefined): Tone {
  if (level === "error" || level === "fatal") {
    return "danger";
  }
  if (level === "warn") {
    return "warn";
  }
  if (level === "info") {
    return "info";
  }
  return "muted";
}

function resolveEventTone(event: string): Tone {
  if (
    event.startsWith("exec.approval") ||
    event.startsWith("device.pair") ||
    event.includes("error") ||
    event.includes("failed")
  ) {
    return event.endsWith("resolved") ? "ok" : "warn";
  }
  if (event === "presence") {
    return "muted";
  }
  return "info";
}

function summarizeEventPayload(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) {
    if (payload == null) {
      return "No payload.";
    }
    return clampText(stringifyPayload(payload) ?? "Payload available.", 140);
  }
  const request = asRecord(record.request);
  const command = asString(request?.command);
  if (command) {
    return clampText(command, 140);
  }
  const candidates = [
    asString(record.message),
    asString(record.text),
    asString(record.summary),
    asString(record.reason),
    asString(record.error),
    asString(record.sessionKey),
    asString(record.agentId),
  ].filter((value): value is string => Boolean(value));
  if (candidates.length > 0) {
    return clampText(candidates[0], 140);
  }
  try {
    return clampText(JSON.stringify(record), 140);
  } catch {
    return "Payload available.";
  }
}

function renderToneBadge(label: string, tone: Tone) {
  return html`<span class="mission-badge ${toneClass(tone)}">${label}</span>`;
}

function renderEmptyState(message: string) {
  return html`<div class="mission-empty">${message}</div>`;
}

function securityFindingTone(severity: "info" | "warn" | "critical"): Tone {
  if (severity === "critical") {
    return "danger";
  }
  if (severity === "warn") {
    return "warn";
  }
  return "info";
}

function resolveHotSessions(sessionsResult: SessionsListResult | null) {
  const sessions = sessionsResult?.sessions ?? [];
  return [...sessions]
    .toSorted((left, right) => {
      const leftRatio = left.contextTokens ? (left.totalTokens ?? 0) / left.contextTokens : 0;
      const rightRatio = right.contextTokens ? (right.totalTokens ?? 0) / right.contextTokens : 0;
      const leftScore =
        (left.abortedLastRun ? 1000 : 0) +
        (left.key.includes(":cron:") ? 350 : 0) +
        (leftRatio >= HOT_SESSION_CONTEXT_THRESHOLD ? 250 : 0) +
        Math.max(0, (left.updatedAt ?? 0) / 1_000_000_000);
      const rightScore =
        (right.abortedLastRun ? 1000 : 0) +
        (right.key.includes(":cron:") ? 350 : 0) +
        (rightRatio >= HOT_SESSION_CONTEXT_THRESHOLD ? 250 : 0) +
        Math.max(0, (right.updatedAt ?? 0) / 1_000_000_000);
      return rightScore - leftScore;
    })
    .slice(0, 8);
}

function formatSessionTokens(
  total: number | null | undefined,
  context: number | null | undefined,
): string {
  if (total == null) {
    return "Tokens n/a";
  }
  if (!context) {
    return `${formatCompactCount(total)} tokens`;
  }
  const ratio = Math.round((total / context) * 100);
  return `${formatCompactCount(total)} / ${formatCompactCount(context)} (${ratio}%)`;
}

function resolveSessionTone(row: SessionsListResult["sessions"][number]): Tone {
  if (row.abortedLastRun) {
    return "danger";
  }
  if (
    row.contextTokens &&
    row.totalTokens &&
    row.totalTokens / row.contextTokens >= HOT_SESSION_CONTEXT_THRESHOLD
  ) {
    return "warn";
  }
  if (row.key.includes(":cron:")) {
    return "info";
  }
  return "ok";
}

function resolveChannelOrder(
  snapshot: ChannelsStatusSnapshot | null,
  health: HealthSummaryLike | null,
): string[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  if (Array.isArray(health?.channelOrder)) {
    return health.channelOrder.filter((entry): entry is string => typeof entry === "string");
  }
  if (health?.channels) {
    return Object.keys(health.channels);
  }
  return [];
}

function resolveChannelCards(
  snapshot: ChannelsStatusSnapshot | null,
  health: HealthSummaryLike | null,
): MissionChannelCard[] {
  const order = resolveChannelOrder(snapshot, health);
  const rawChannels = snapshot?.channels ?? {};
  const healthChannels = health?.channels ?? {};
  const labels = {
    ...health?.channelLabels,
    ...snapshot?.channelLabels,
  };
  return order.map((channelId) => {
    const channelRecord = asRecord(rawChannels[channelId]) ?? {};
    const healthRecord = asRecord(healthChannels[channelId]) as HealthChannelSummaryLike | null;
    const accounts = snapshot?.channelAccounts?.[channelId] ?? [];
    const healthAccounts = Object.values(healthRecord?.accounts ?? {});
    const accountCount = accounts.length || healthAccounts.length;
    const lastActivityAt = accounts
      .flatMap((account) => [
        account.lastInboundAt ?? null,
        account.lastOutboundAt ?? null,
        account.lastProbeAt ?? null,
        account.lastConnectedAt ?? null,
      ])
      .filter((value): value is number => typeof value === "number")
      .reduce<number | null>(
        (latest, value) => (latest == null || value > latest ? value : latest),
        null,
      );

    const rawError = asString(channelRecord.lastError);
    const accountError = accounts
      .map((account) => account.lastError)
      .find((value): value is string => Boolean(value));
    const probeRecord = asRecord(healthRecord?.probe);
    const probeOk = asBoolean(probeRecord?.ok);
    const probeError = asString(probeRecord?.error);
    const linked = asBoolean(channelRecord.linked) ?? asBoolean(healthRecord?.linked);
    const configured =
      asBoolean(channelRecord.configured) ??
      asBoolean(healthRecord?.configured) ??
      accounts.some((account) => account.configured !== false);
    const running =
      asBoolean(channelRecord.running) ?? accounts.some((account) => account.running === true);
    const connected =
      asBoolean(channelRecord.connected) ?? accounts.some((account) => account.connected === true);
    const recentActivity = accounts.some(
      (account) =>
        hasRecentActivity(account.lastInboundAt) || hasRecentActivity(account.lastOutboundAt),
    );

    let tone: Tone = "muted";
    let summary = "Not configured";
    let detail = "No account configured for this channel.";

    if (rawError || accountError) {
      tone = "danger";
      summary = "Attention required";
      detail = clampText(rawError ?? accountError ?? "Channel error detected.", 120);
    } else if (probeOk === false) {
      tone = "warn";
      summary = "Probe degraded";
      detail = clampText(probeError ?? "Last health probe failed.", 120);
    } else if (linked === false) {
      tone = "warn";
      summary = "Link required";
      detail = "Channel auth is configured but not linked yet.";
    } else if (connected || running || recentActivity || linked === true) {
      tone = "ok";
      summary = recentActivity ? "Live traffic" : linked === true ? "Linked" : "Healthy";
      detail = recentActivity
        ? formatLastActivity(lastActivityAt)
        : linked === true
          ? "Gateway auth is linked and ready for traffic."
          : "Channel is healthy and ready.";
    } else if (configured) {
      tone = "warn";
      summary = "Configured";
      detail = "Configured, but there is no recent live traffic or active link.";
    }

    return {
      id: channelId,
      label:
        snapshot?.channelMeta?.find((entry) => entry.id === channelId)?.label ??
        labels[channelId] ??
        channelId,
      tone,
      summary,
      detail,
      accountCount,
      lastActivityAt,
    };
  });
}

function resolveUsageSnapshot(
  usageResult: SessionsUsageResult | null,
  usageCostSummary: CostUsageSummary | null,
): UsageSnapshot {
  const byAgent = [...(usageResult?.aggregates.byAgent ?? [])].toSorted(
    (left, right) => (right.totals?.totalCost ?? 0) - (left.totals?.totalCost ?? 0),
  );
  const byModel = [...(usageResult?.aggregates.byModel ?? [])].toSorted(
    (left, right) => (right.totals?.totalCost ?? 0) - (left.totals?.totalCost ?? 0),
  );
  const tools = [...(usageResult?.aggregates.tools.tools ?? [])].toSorted(
    (left, right) => right.count - left.count,
  );
  return {
    totalCost: usageCostSummary?.totals.totalCost ?? usageResult?.totals.totalCost ?? null,
    totalTokens: usageResult?.totals.totalTokens ?? usageCostSummary?.totals.totalTokens ?? null,
    sessions: usageResult?.sessions.length ?? 0,
    messages: usageResult?.aggregates.messages.total ?? 0,
    errors: usageResult?.aggregates.messages.errors ?? 0,
    topAgent: byAgent[0]?.agentId ?? null,
    topTool: tools[0]?.name ?? null,
    topModel: byModel[0]?.model ?? byModel[0]?.provider ?? null,
    latencyP95Ms: usageResult?.aggregates.latency?.p95Ms ?? null,
  };
}

function resolveLastHeartbeat(payload: unknown) {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const ts = asNumber(record.ts);
  if (!ts) {
    return null;
  }
  return {
    ts,
    status: asString(record.status) ?? "unknown",
    channel: asString(record.channel),
    accountId: asString(record.accountId),
  };
}

function resolveRecentLogCounts(entries: LogEntry[]) {
  return entries.slice(-80).reduce(
    (acc, entry) => {
      if (entry.level === "warn") {
        acc.warn += 1;
      }
      if (entry.level === "error" || entry.level === "fatal") {
        acc.error += 1;
      }
      return acc;
    },
    { warn: 0, error: 0 },
  );
}

function resolveAgentIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) {
    return null;
  }
  return parseAgentSessionKey(sessionKey)?.agentId ?? null;
}

function resolveNodeCards(nodes: Array<Record<string, unknown>>): MissionNodeCard[] {
  const cards: MissionNodeCard[] = [];
  for (const node of nodes) {
    const nodeId = asString(node.nodeId);
    if (!nodeId) {
      continue;
    }
    const displayName = asString(node.displayName) ?? nodeId;
    const platform = asString(node.platform);
    const version =
      asString(node.version) ?? asString(node.uiVersion) ?? asString(node.coreVersion);
    const commands = Array.isArray(node.commands)
      ? node.commands.map((entry) => String(entry))
      : [];
    const connected = asBoolean(node.connected) === true;
    const paired = asBoolean(node.paired) !== false;
    const tone: Tone = connected ? "ok" : paired ? "warn" : "muted";
    cards.push({
      nodeId,
      label: displayName,
      detail: [
        platform,
        version,
        commands.length > 0 ? `${commands.length} commands` : "no commands",
      ]
        .filter(Boolean)
        .join(" · "),
      commands,
      connected,
      paired,
      tone,
    });
  }
  return cards
    .toSorted((left, right) => {
      if (left.connected !== right.connected) {
        return left.connected ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    })
    .slice(0, 4);
}

function resolveNodeIdFromText(text: string, nodeCards: MissionNodeCard[]): string | undefined {
  const lower = text.toLowerCase();
  const byId = nodeCards.find((node) => lower.includes(node.nodeId.toLowerCase()));
  if (byId) {
    return byId.nodeId;
  }
  return nodeCards.find((node) => {
    const label = node.label.trim().toLowerCase();
    return label.length >= 5 && label !== node.nodeId.toLowerCase() && lower.includes(label);
  })?.nodeId;
}

function resolveIncidentContextFromText(
  text: string,
  channelCards: MissionChannelCard[],
  nodeCards: MissionNodeCard[],
): Pick<MissionIncident, "sessionKey" | "agentId" | "channelId" | "nodeId"> {
  const sessionMatch = text.match(/\b(?:agent:[^\s]+:[^\s]+|cron:[^\s]+|main)\b/);
  const sessionKey = sessionMatch?.[0] ?? undefined;
  const lower = text.toLowerCase();
  const agentMatch = text.match(/\bagent(?:Id)?[=: ]([A-Za-z0-9._-]+)/i);
  const channelId = channelCards.find((channel) => {
    const needle = channel.id.toLowerCase();
    return lower.includes(needle);
  })?.id;
  return {
    sessionKey,
    agentId: agentMatch?.[1] ?? resolveAgentIdFromSessionKey(sessionKey) ?? undefined,
    channelId,
    nodeId: resolveNodeIdFromText(text, nodeCards),
  };
}

function resolveMissionIncidents(params: {
  execApprovalQueue: ExecApprovalRequest[];
  degradedChannels: MissionChannelCard[];
  nodeCards: MissionNodeCard[];
  failingCronJobs: CronJob[];
  securityFindings: DashboardSummaryResult["security"]["topFindings"];
  logsEntries: LogEntry[];
  channelCards: MissionChannelCard[];
}): MissionIncident[] {
  const incidents: MissionIncident[] = [];
  for (const entry of params.execApprovalQueue.slice(0, 2)) {
    const sessionKey = entry.request.sessionKey ?? undefined;
    const agentId = entry.request.agentId ?? resolveAgentIdFromSessionKey(sessionKey) ?? undefined;
    incidents.push({
      id: `approval:${entry.id}`,
      tone: "warn",
      title: clampText(entry.request.command, 64),
      detail: `Exec approval waiting${agentId ? ` · ${agentId}` : ""}`,
      logQuery: entry.request.command,
      sessionKey,
      agentId,
    });
  }
  for (const channel of params.degradedChannels.slice(0, 2)) {
    incidents.push({
      id: `channel:${channel.id}`,
      tone: channel.tone === "danger" ? "danger" : "warn",
      title: `${channel.label} degraded`,
      detail: channel.detail,
      logQuery: channel.id,
      channelId: channel.id,
    });
  }
  for (const node of params.nodeCards
    .filter((entry) => !entry.connected || !entry.paired)
    .slice(0, 2)) {
    incidents.push({
      id: `node:${node.nodeId}`,
      tone: node.connected ? "warn" : "danger",
      title: `${node.label} ${node.connected ? "needs review" : "offline"}`,
      detail: node.connected
        ? `Node is paired but degraded. ${node.detail}`
        : `Node is not connected to the gateway. ${node.detail}`,
      logQuery: node.nodeId,
      nodeId: node.nodeId,
      actionLabel: "Open nodes",
      actionTab: "nodes",
    });
  }
  for (const job of params.failingCronJobs.slice(0, 2)) {
    incidents.push({
      id: `cron:${job.id}`,
      tone: "danger",
      title: `${job.name} failed`,
      detail: clampText(job.state?.lastError ?? "Cron run failed.", 120),
      logQuery: job.name,
      actionLabel: "Open cron",
      actionTab: "cron",
    });
  }
  for (const finding of params.securityFindings.slice(0, 2)) {
    incidents.push({
      id: `security:${finding.title}`,
      tone: securityFindingTone(finding.severity),
      title: finding.title,
      detail: finding.detail,
      logQuery: finding.title,
      actionLabel: "Open config",
      actionTab: "config",
    });
  }
  for (const entry of params.logsEntries
    .filter((log) => log.level === "error" || log.level === "fatal")
    .slice(-2)) {
    const text = `${entry.subsystem ?? ""} ${entry.message ?? entry.raw}`;
    const context = resolveIncidentContextFromText(text, params.channelCards, params.nodeCards);
    incidents.push({
      id: `log:${entry.time ?? entry.raw}`,
      tone: resolveLogTone(entry.level),
      title: clampText(entry.message ?? entry.raw, 72),
      detail: clampText(entry.subsystem ?? entry.raw, 120),
      logQuery: entry.message ?? entry.subsystem ?? entry.raw,
      sessionKey: context.sessionKey,
      agentId: context.agentId,
      channelId: context.channelId,
      nodeId: context.nodeId,
    });
  }
  const deduped: MissionIncident[] = [];
  const seen = new Set<string>();
  for (const incident of incidents) {
    if (seen.has(incident.id)) {
      continue;
    }
    seen.add(incident.id);
    deduped.push(incident);
    if (deduped.length >= 8) {
      break;
    }
  }
  return deduped;
}

function renderIncidentContext(incident: MissionIncident) {
  const context = [
    incident.sessionKey ? { label: "session", value: incident.sessionKey } : null,
    incident.agentId ? { label: "agent", value: incident.agentId } : null,
    incident.channelId ? { label: "channel", value: incident.channelId } : null,
    incident.nodeId ? { label: "node", value: incident.nodeId } : null,
  ].filter((entry): entry is { label: string; value: string } => Boolean(entry));
  if (context.length === 0) {
    return nothing;
  }
  return html`
    <div class="mission-context-list">
      ${context.map(
        (entry) => html`
          <span class="mission-context-chip">
            <span class="mission-context-chip__label">${entry.label}</span>
            <span class="mono">${entry.value}</span>
          </span>
        `,
      )}
    </div>
  `;
}

function isOverviewTab(value: string | null | undefined): value is Tab {
  return (
    value === "agents" ||
    value === "overview" ||
    value === "channels" ||
    value === "instances" ||
    value === "sessions" ||
    value === "usage" ||
    value === "cron" ||
    value === "skills" ||
    value === "nodes" ||
    value === "chat" ||
    value === "config" ||
    value === "debug" ||
    value === "logs"
  );
}

function incidentToneFromBackend(incident: DashboardIncidentRecord): Tone {
  if (incident.severity === "critical") {
    return "danger";
  }
  if (incident.severity === "warn") {
    return incident.status === "acked" ? "info" : "warn";
  }
  return incident.status === "acked" ? "muted" : "info";
}

function resolveManagedIncidents(
  dashboard: DashboardSummaryResult | null,
  fallback: MissionIncident[],
): MissionIncident[] {
  const active = dashboard?.incidents.active ?? [];
  if (active.length === 0) {
    return fallback;
  }
  const managed = active.map(
    (incident) =>
      ({
        id: incident.id,
        tone: incidentToneFromBackend(incident),
        title: incident.title,
        detail: incident.detail,
        status: incident.status,
        backendManaged: true,
        logQuery: incident.metadata.logQuery ?? undefined,
        sessionKey: incident.metadata.sessionKey ?? undefined,
        agentId: incident.metadata.agentId ?? undefined,
        channelId: incident.metadata.channelId ?? undefined,
        nodeId: incident.metadata.nodeId ?? undefined,
        actionTab: isOverviewTab(incident.metadata.actionTab)
          ? incident.metadata.actionTab
          : undefined,
        actionLabel: incident.metadata.actionLabel ?? undefined,
      }) satisfies MissionIncident,
  );
  const managedIds = new Set(managed.map((incident) => incident.id));
  return [...managed, ...fallback.filter((incident) => !managedIds.has(incident.id))].slice(0, 8);
}

type MissionTrendCard = {
  id: string;
  label: string;
  detail: string;
  value: string;
  tone: Tone;
  series: number[];
};

function resolveQueuePressure(point: DashboardTimelinePoint): number {
  return point.queueSize + point.pendingReplies + point.activeEmbeddedRuns;
}

function resolveAlertPressure(point: DashboardTimelinePoint): number {
  return (
    point.logErrors * 2 +
    point.logWarnings +
    point.approvals +
    point.pendingDevices +
    point.securityCritical * 3 +
    point.securityWarn
  );
}

function renderMissionTrendSparkline(series: number[], tone: Tone) {
  if (series.length < 2) {
    return html`
      <div class="mission-trend__empty">Building live trace...</div>
    `;
  }
  const width = 220;
  const height = 56;
  const max = Math.max(...series, 1);
  const stepX = series.length > 1 ? width / (series.length - 1) : width;
  const points = series.map((value, index) => {
    const x = index * stepX;
    const y = height - (value / max) * (height - 6) - 3;
    return `${x},${y}`;
  });
  const areaPoints = [`0,${height}`, ...points, `${width},${height}`].join(" ");
  const linePoints = points.join(" ");
  return svg`
    <svg class="mission-trend__sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <polygon class="mission-trend__area ${toneClass(tone)}" points=${areaPoints}></polygon>
      <polyline class="mission-trend__line ${toneClass(tone)}" points=${linePoints}></polyline>
    </svg>
  `;
}

function renderMissionTrendCards(points: DashboardTimelinePoint[]) {
  const recent = points.slice(-60);
  const latest = recent[recent.length - 1] ?? null;
  if (!latest) {
    return renderEmptyState("Collecting 15-minute drift data.");
  }
  const cards: MissionTrendCard[] = [
    {
      id: "cost",
      label: "Spend drift",
      detail: "15m rolling cost trace",
      value: formatMoney(latest.cost),
      tone: "info",
      series: recent.map((entry) => entry.cost ?? 0),
    },
    {
      id: "queue",
      label: "Queue pressure",
      detail: "Queue + pending replies + embedded runs",
      value: formatCount(resolveQueuePressure(latest)),
      tone: resolveQueuePressure(latest) > 0 ? "warn" : "ok",
      series: recent.map(resolveQueuePressure),
    },
    {
      id: "alerts",
      label: "Alert pressure",
      detail: "Security, approvals, devices, warning/error logs",
      value: formatCount(resolveAlertPressure(latest)),
      tone:
        latest.logErrors > 0 || latest.securityCritical > 0
          ? "danger"
          : resolveAlertPressure(latest) > 0
            ? "warn"
            : "ok",
      series: recent.map(resolveAlertPressure),
    },
  ];
  return html`
    <div class="mission-trend-grid">
      ${cards.map(
        (card) => html`
          <div class="mission-trend ${toneClass(card.tone)}">
            <div class="mission-trend__header">
              <div>
                <div class="mission-trend__label">${card.label}</div>
                <div class="mission-trend__detail">${card.detail}</div>
              </div>
              <div class="mission-trend__value">${card.value}</div>
            </div>
            ${renderMissionTrendSparkline(card.series, card.tone)}
          </div>
        `,
      )}
    </div>
  `;
}

function resolveAlerts(params: {
  connected: boolean;
  lastError: string | null;
  degradedChannels: MissionChannelCard[];
  failingCronJobs: CronJob[];
  execApprovalCount: number;
  pendingDeviceCount: number;
  securitySummary: DashboardSummaryResult["security"]["summary"] | null;
  queuedSystemEvents: string[];
  logCounts: { warn: number; error: number };
  errors: Array<string | null>;
}): MissionAlert[] {
  const alerts: MissionAlert[] = [];
  if (!params.connected) {
    alerts.push({
      tone: "danger",
      title: "Gateway offline",
      detail: params.lastError ?? "Live telemetry is disconnected.",
    });
  }
  if (params.securitySummary?.critical) {
    alerts.push({
      tone: "danger",
      title: `${formatCount(params.securitySummary.critical)} critical security findings`,
      detail: "The cached gateway security audit reports high-impact exposure that needs review.",
    });
  }
  if (params.securitySummary?.warn) {
    alerts.push({
      tone: "warn",
      title: `${formatCount(params.securitySummary.warn)} security warnings`,
      detail: "The gateway audit reports medium-risk findings that should be reviewed.",
    });
  }
  if (params.execApprovalCount > 0) {
    alerts.push({
      tone: "warn",
      title: `${formatCount(params.execApprovalCount)} exec approval waiting`,
      detail: "A command is blocked until an operator approves or denies it.",
    });
  }
  if (params.pendingDeviceCount > 0) {
    alerts.push({
      tone: "warn",
      title: `${formatCount(params.pendingDeviceCount)} device pairing pending`,
      detail: "A device is waiting for approval to join the gateway.",
    });
  }
  if (params.failingCronJobs.length > 0) {
    alerts.push({
      tone: "danger",
      title: `${formatCount(params.failingCronJobs.length)} cron job failures`,
      detail: "Recurring runs have failed and need operator review.",
    });
  }
  if (params.degradedChannels.length > 0) {
    alerts.push({
      tone: "warn",
      title: `${formatCount(params.degradedChannels.length)} degraded channels`,
      detail: "One or more inboxes are configured but not fully healthy.",
    });
  }
  if (params.logCounts.error > 0) {
    alerts.push({
      tone: "danger",
      title: `${formatCount(params.logCounts.error)} recent error logs`,
      detail: "The live tail contains recent error or fatal entries.",
    });
  }
  if (params.logCounts.warn > 0) {
    alerts.push({
      tone: "warn",
      title: `${formatCount(params.logCounts.warn)} recent warnings`,
      detail: "The live tail contains warning-level events.",
    });
  }
  if (params.queuedSystemEvents.length > 0) {
    alerts.push({
      tone: "info",
      title: `${formatCount(params.queuedSystemEvents.length)} queued system events`,
      detail: "System events are queued for the default agent session.",
    });
  }
  for (const error of params.errors) {
    if (!error) {
      continue;
    }
    alerts.push({
      tone: "warn",
      title: "Snapshot warning",
      detail: clampText(error, 120),
    });
  }
  return alerts.slice(0, 6);
}

function resolveFeed(eventLog: EventLogEntry[], logsEntries: LogEntry[]): MissionFeedItem[] {
  const events = eventLog.slice(0, 10).map((entry, index) => ({
    id: `event-${index}-${entry.ts}`,
    tone: resolveEventTone(entry.event),
    source: "event" as const,
    ts: entry.ts,
    label: entry.event,
    title: entry.event,
    detail: summarizeEventPayload(entry.payload),
  }));
  const logs = logsEntries.slice(-12).map((entry, index) => ({
    id: `log-${index}-${entry.time ?? index}`,
    tone: resolveLogTone(entry.level),
    source: "log" as const,
    ts: resolveLogTimestamp(entry, index),
    label: entry.level?.toUpperCase() ?? "LOG",
    title: entry.subsystem ?? entry.level ?? "log",
    detail: clampText(entry.message ?? entry.raw, 160),
  }));
  return [...events, ...logs].toSorted((left, right) => right.ts - left.ts).slice(0, 12);
}
function renderMissionAccess(
  props: OverviewProps,
  authMode: string | null,
  tickLabel: string,
  uptimeLabel: string,
) {
  const isTrustedProxy = authMode === "trusted-proxy";
  const authHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const lower = props.lastError.toLowerCase();
    const authFailed = lower.includes("unauthorized") || lower.includes("connect failed");
    if (!authFailed) {
      return null;
    }
    const hasToken = Boolean(props.settings.token.trim());
    const hasPassword = Boolean(props.password.trim());
    if (!hasToken && !hasPassword) {
      return html`
        <div class="muted mission-access__hint">
          This gateway requires auth. Add a token or password, then reconnect.
          <div class="mission-access__docs">
            <span class="mono">openclaw dashboard --no-open</span> opens the Control UI.<br />
            <span class="mono">openclaw doctor --generate-gateway-token</span> creates a token.
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted mission-access__hint">
        Auth failed. Update the token or password, then reconnect.
      </div>
    `;
  })();
  const insecureContextHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true;
    if (isSecureContext) {
      return null;
    }
    const lower = props.lastError.toLowerCase();
    if (!lower.includes("secure context") && !lower.includes("device identity required")) {
      return null;
    }
    return html`
      <div class="muted mission-access__hint">
        This page is HTTP, so the browser blocks device identity. Use HTTPS or open
        <span class="mono">http://127.0.0.1:18789</span> on the gateway host.
      </div>
    `;
  })();

  return html`
    <details class="mission-access" open>
      <summary class="mission-access__summary">
        <div>
          <div class="card-title">Gateway Access</div>
          <div class="card-sub">Endpoint, auth, and default session routing.</div>
        </div>
        <div class="mission-access__meta">
          ${renderToneBadge(props.connected ? "Connected" : "Disconnected", props.connected ? "ok" : "danger")}
          <span class="muted">Uptime ${uptimeLabel} · Tick ${tickLabel}</span>
        </div>
      </summary>
      <div class="mission-access__body">
        <div class="form-grid">
          <label class="field">
            <span>WebSocket URL</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(event: Event) => {
                const value = (event.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: value });
              }}
              placeholder="ws://127.0.0.1:18789"
            />
          </label>
          ${
            isTrustedProxy
              ? nothing
              : html`
                  <label class="field">
                    <span>Gateway Token</span>
                    <input
                      .value=${props.settings.token}
                      @input=${(event: Event) => {
                        const value = (event.target as HTMLInputElement).value;
                        props.onSettingsChange({ ...props.settings, token: value });
                      }}
                      placeholder="OPENCLAW_GATEWAY_TOKEN"
                    />
                  </label>
                  <label class="field">
                    <span>Password (not stored)</span>
                    <input
                      type="password"
                      .value=${props.password}
                      @input=${(event: Event) => {
                        const value = (event.target as HTMLInputElement).value;
                        props.onPasswordChange(value);
                      }}
                      placeholder="system or shared password"
                    />
                  </label>
                `
          }
          <label class="field">
            <span>Default Session Key</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(event: Event) => {
                const value = (event.target as HTMLInputElement).value;
                props.onSessionKeyChange(value);
              }}
            />
          </label>
        </div>
        <div class="mission-access__footer">
          <div class="row">
            <button class="btn primary" type="button" @click=${() => props.onConnect()}>Reconnect</button>
            <button class="btn" type="button" @click=${() => props.onRefresh()}>Refresh snapshot</button>
          </div>
          <div class="muted">
            ${isTrustedProxy ? "Authenticated via trusted proxy." : `Auth mode: ${authMode ?? "unknown"}.`}
          </div>
        </div>
        ${
          props.lastError
            ? html`<div class="callout danger">${props.lastError}${authHint ?? nothing}${insecureContextHint ?? nothing}</div>`
            : nothing
        }
      </div>
    </details>
  `;
}

export function renderOverview(props: OverviewProps) {
  const gatewaySnapshot = props.hello?.snapshot as
    | {
        uptimeMs?: number;
        policy?: { tickIntervalMs?: number };
        authMode?: "none" | "token" | "password" | "trusted-proxy";
      }
    | undefined;
  const status = asStatusSummary(props.debugStatus);
  const health = asHealthSummary(props.debugHealth);
  const uptimeLabel = gatewaySnapshot?.uptimeMs
    ? formatDurationHuman(gatewaySnapshot.uptimeMs)
    : "n/a";
  const tickLabel = gatewaySnapshot?.policy?.tickIntervalMs
    ? `${gatewaySnapshot.policy.tickIntervalMs}ms`
    : "n/a";
  const authMode = gatewaySnapshot?.authMode ?? null;
  const channelCards = resolveChannelCards(props.channelsSnapshot, health);
  const degradedChannels = channelCards.filter(
    (entry) => entry.tone === "warn" || entry.tone === "danger",
  );
  const hotSessions = resolveHotSessions(props.sessionsResult);
  const failingCronJobs = props.cronJobs.filter(
    (job) => job.state?.lastStatus === "error" || Boolean(job.state?.lastError),
  );
  const pendingDevices = props.devicesList?.pending ?? [];
  const pairedDevices = props.devicesList?.paired ?? [];
  const dashboard = props.dashboardSummary;
  const securitySummary = dashboard?.security.summary ?? null;
  const securityFindings = dashboard?.security.topFindings ?? [];
  const runtimeBacklog = dashboard?.runtime ?? null;
  const approvalCount = dashboard?.approvals.count ?? props.execApprovalQueue.length;
  const pendingDeviceCount = dashboard?.devices.pending ?? pendingDevices.length;
  const pairedDeviceCount = dashboard?.devices.paired ?? pairedDevices.length;
  const nodeCount = dashboard?.nodes.count ?? props.nodesCount;
  const hasMobileNodeConnected = dashboard?.nodes.hasMobileNodeConnected ?? false;
  const dashboardTimeline = props.dashboardTimeline;
  const nodeCards = resolveNodeCards(props.nodes);
  const securityTone: Tone = securitySummary?.critical
    ? "danger"
    : securitySummary?.warn
      ? "warn"
      : securitySummary
        ? "ok"
        : "muted";
  const securityTotalFindings = (securitySummary?.critical ?? 0) + (securitySummary?.warn ?? 0);
  const queuedSystemEvents = Array.isArray(status?.queuedSystemEvents)
    ? status.queuedSystemEvents.filter((entry): entry is string => typeof entry === "string")
    : [];
  const heartbeatAgents = Array.isArray(status?.heartbeat?.agents)
    ? status.heartbeat.agents.filter((entry): entry is StatusHeartbeatAgentLike => Boolean(entry))
    : [];
  const lastHeartbeat = resolveLastHeartbeat(props.debugHeartbeat);
  const logCounts = resolveRecentLogCounts(props.logsEntries);
  const localIncidents = resolveMissionIncidents({
    execApprovalQueue: props.execApprovalQueue,
    degradedChannels,
    nodeCards,
    failingCronJobs,
    securityFindings,
    logsEntries: props.logsEntries,
    channelCards,
  });
  const incidents = resolveManagedIncidents(dashboard, localIncidents);
  const activeIncidentCount = dashboard?.incidents.summary.active ?? incidents.length;
  const alerts = resolveAlerts({
    connected: props.connected,
    lastError: props.lastError,
    degradedChannels,
    failingCronJobs,
    execApprovalCount: approvalCount,
    pendingDeviceCount,
    securitySummary,
    queuedSystemEvents,
    logCounts,
    errors: [
      props.dashboardError,
      props.channelsError,
      props.cronError,
      props.sessionsError,
      props.presenceError,
      props.logsError,
      props.devicesError,
      props.usageError,
    ],
  });
  const feed = resolveFeed(props.eventLog, props.logsEntries);
  const usage = resolveUsageSnapshot(props.usageResult, props.usageCostSummary);
  const allClear = alerts.length === 0 && activeIncidentCount === 0;
  const title = !props.connected
    ? "Gateway connection lost"
    : alerts.some((entry) => entry.tone === "danger")
      ? "OpenClaw needs operator attention"
      : alerts.some((entry) => entry.tone === "warn") || activeIncidentCount > 0
        ? "OpenClaw is healthy with active watch items"
        : "OpenClaw is stable and streaming live telemetry";
  const subtitle = props.connected
    ? `Connected to ${props.settings.gatewayUrl}. ${formatCount(props.sessionsResult?.count ?? 0)} sessions, ${formatCount(channelCards.length)} channels, ${formatCount(props.cronJobs.length)} cron jobs, ${formatCount(nodeCount)} connected nodes${hasMobileNodeConnected ? ", mobile link online" : ""}.`
    : "Reconnect to resume live sync across sessions, channels, cron, nodes, and approvals.";

  return html`
    <section class="mission-control">
      <section class="card mission-hero">
        <div class="mission-hero__grid">
          <div class="mission-hero__main">
            <div class="mission-hero__eyebrow">Realtime command center</div>
            <div class="mission-hero__title">${title}</div>
            <div class="mission-hero__copy">${subtitle}</div>
            <div class="mission-hero__meta">
              ${renderToneBadge(props.connected ? "Live sync" : "Offline", props.connected ? "ok" : "danger")}
              ${renderToneBadge(`Auth ${authMode ?? "unknown"}`, authMode === "trusted-proxy" ? "info" : "muted")}
              ${
                securitySummary
                  ? renderToneBadge(
                      securityTotalFindings > 0
                        ? `Security ${formatCount(securityTotalFindings)}`
                        : "Security clear",
                      securityTone,
                    )
                  : nothing
              }
              ${hasMobileNodeConnected ? renderToneBadge("Mobile node online", "info") : nothing}
              <span class="mission-hero__meta-text">Uptime ${uptimeLabel}</span>
              <span class="mission-hero__meta-text">Tick ${tickLabel}</span>
              ${
                dashboard?.security?.ts
                  ? html`<span class="mission-hero__meta-text">
                      Audit ${dashboard.security.cached ? "cached" : "fresh"} ${formatRelativeTimestamp(dashboard.security.ts)}
                    </span>`
                  : nothing
              }
              <span class="mission-hero__meta-text">
                Channels refresh ${formatRelativeOrNa(props.lastChannelsRefresh)}
              </span>
            </div>
            <div class="mission-actions">
              <button class="btn primary" type="button" @click=${() => props.onNavigate("chat")}>Open chat</button>
              <button class="btn" type="button" @click=${() => props.onNavigate("channels")}>Channels</button>
              <button class="btn" type="button" @click=${() => props.onNavigate("cron")}>Cron</button>
              <button class="btn" type="button" @click=${() => props.onNavigate("logs")}>Logs</button>
              <button class="btn" type="button" @click=${() => props.onNavigate("nodes")}>Nodes</button>
              <button class="btn" type="button" @click=${() => props.onConnect()}>Reconnect</button>
            </div>
          </div>
          <div class="mission-hero__side">
            <div class="mission-hero__panel">
              <div class="mission-hero__panel-title">Operator queue</div>
              <div class="mission-hero__panel-value">${allClear ? "All clear" : formatCount(activeIncidentCount)}</div>
              <div class="mission-hero__panel-copy">
                ${allClear ? "No active incidents in the current snapshot." : "Live issues are prioritized below."}
              </div>
            </div>
            <div class="mission-alert-stack">
              ${
                allClear
                  ? html`
                      <div class="mission-alert ${toneClass("ok")}">
                        <div class="mission-alert__title">Stable runtime</div>
                        <div class="mission-alert__detail">
                          Channels, sessions, cron, and logs do not show urgent incidents right now.
                        </div>
                      </div>
                    `
                  : alerts.slice(0, 4).map(
                      (alert) => html`
                        <div class="mission-alert ${toneClass(alert.tone)}">
                          <div class="mission-alert__title">${alert.title}</div>
                          <div class="mission-alert__detail">${alert.detail}</div>
                        </div>
                      `,
                    )
              }
            </div>
          </div>
        </div>
      </section>

      <section class="mission-kpis">
        <article class="mission-kpi card">
          <div class="mission-kpi__label">Sessions</div>
          <div class="mission-kpi__value">${formatCount(props.sessionsResult?.count ?? 0)}</div>
          <div class="mission-kpi__detail">
            Default ${status?.sessions?.defaults?.model ?? "model n/a"}
            ${
              status?.sessions?.defaults?.contextTokens
                ? html` · ${formatCompactCount(status.sessions.defaults.contextTokens)} ctx`
                : nothing
            }
          </div>
        </article>
        <article class="mission-kpi card">
          <div class="mission-kpi__label">Channels</div>
          <div class="mission-kpi__value">${formatCount(channelCards.length)}</div>
          <div class="mission-kpi__detail">
            ${degradedChannels.length > 0 ? `${formatCount(degradedChannels.length)} degraded` : "No degraded channels"}
          </div>
        </article>
        <article class="mission-kpi card">
          <div class="mission-kpi__label">Cron</div>
          <div class="mission-kpi__value">${props.cronStatus?.enabled ? formatCount(props.cronJobs.length) : "Paused"}</div>
          <div class="mission-kpi__detail">Next wake ${formatNextRun(props.cronStatus?.nextWakeAtMs ?? null)}</div>
        </article>
        <article class="mission-kpi card">
          <div class="mission-kpi__label">Approvals</div>
          <div class="mission-kpi__value">${formatCount(approvalCount + pendingDeviceCount)}</div>
          <div class="mission-kpi__detail">
            ${formatCount(approvalCount)} exec · ${formatCount(pendingDeviceCount)} device
          </div>
        </article>
        <article class="mission-kpi card">
          <div class="mission-kpi__label">Usage window</div>
          <div class="mission-kpi__value">${formatMoney(usage.totalCost)}</div>
          <div class="mission-kpi__detail">${formatCompactCount(usage.totalTokens)} tokens</div>
        </article>
        <article class="mission-kpi card">
          <div class="mission-kpi__label">Recent logs</div>
          <div class="mission-kpi__value">${formatCount(logCounts.error + logCounts.warn)}</div>
          <div class="mission-kpi__detail">
            ${formatCount(logCounts.error)} errors · ${formatCount(logCounts.warn)} warnings
          </div>
        </article>
        <article class="mission-kpi card">
          <div class="mission-kpi__label">Security</div>
          <div class="mission-kpi__value">
            ${securitySummary && securityTotalFindings === 0 ? "Clear" : formatCount(securityTotalFindings)}
          </div>
          <div class="mission-kpi__detail">
            ${
              securitySummary
                ? `${formatCount(securitySummary.critical)} critical · ${formatCount(securitySummary.warn)} warnings`
                : "Audit summary unavailable"
            }
          </div>
        </article>
        <article class="mission-kpi card">
          <div class="mission-kpi__label">Instances</div>
          <div class="mission-kpi__value">${formatCount(props.presenceEntries.length)}</div>
          <div class="mission-kpi__detail">
            ${formatCount(nodeCount)} connected nodes${hasMobileNodeConnected ? " · mobile online" : ""}
          </div>
        </article>
        <article class="mission-kpi card">
          <div class="mission-kpi__label">System events</div>
          <div class="mission-kpi__value">${formatCount(queuedSystemEvents.length)}</div>
          <div class="mission-kpi__detail">
            ${lastHeartbeat ? `${lastHeartbeat.status} ${formatRelativeTimestamp(lastHeartbeat.ts)}` : "No heartbeat event yet"}
          </div>
        </article>
      </section>

      <section class="mission-grid">
        <article class="card mission-panel mission-panel--span-7">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Live Activity</div>
              <div class="card-sub">Merged event stream and recent log tail.</div>
            </div>
            <div class="mission-panel__meta">
              ${renderToneBadge(`Events ${formatCount(props.eventLog.length)}`, "info")}
              <span class="muted">Logs ${formatRelativeOrNa(props.logsLastFetchAt)}</span>
            </div>
          </div>
          <div class="mission-feed">
            ${
              feed.length === 0
                ? renderEmptyState("No live events yet.")
                : feed.map(
                    (item) => html`
                      <div class="mission-feed__item ${toneClass(item.tone)}">
                        <div class="mission-feed__stamp">
                          ${renderToneBadge(item.source === "event" ? item.label : item.label.toLowerCase(), item.tone)}
                          <span class="muted">${formatRelativeTimestamp(item.ts)}</span>
                        </div>
                        <div class="mission-feed__title">${item.title}</div>
                        <div class="mission-feed__detail">${item.detail}</div>
                      </div>
                    `,
                  )
            }
          </div>
        </article>

        <article class="card mission-panel mission-panel--span-5">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Operator Queue</div>
              <div class="card-sub">Pending approvals, device pairing, and incident watchlist.</div>
            </div>
            <button class="btn btn--sm" type="button" @click=${() => props.onNavigate("nodes")}>Open nodes</button>
          </div>
          <div class="mission-stack">
            <section class="mission-subpanel">
              <div class="mission-subpanel__title">Exec approvals</div>
              ${
                props.execApprovalQueue.length === 0
                  ? renderEmptyState(
                      approvalCount > 0
                        ? `${formatCount(approvalCount)} exec approvals pending, detail snapshot not loaded yet.`
                        : "No blocked exec commands.",
                    )
                  : props.execApprovalQueue.slice(0, 4).map(
                      (entry) => html`
                        <div class="mission-row">
                          <div class="mission-row__body">
                            <div class="mission-row__title">${clampText(entry.request.command, 72)}</div>
                            <div class="mission-row__detail">
                              ${entry.request.agentId ?? "agent unknown"}
                              ${entry.request.sessionKey ? html` · ${entry.request.sessionKey}` : nothing}
                              ${entry.request.cwd ? html` · ${entry.request.cwd}` : nothing}
                            </div>
                            ${
                              entry.request.ask
                                ? html`<div class="mission-inline-note">${clampText(entry.request.ask, 140)}</div>`
                                : nothing
                            }
                            <div class="mission-actions-inline">
                              <button
                                class="btn btn--sm"
                                type="button"
                                ?disabled=${props.execApprovalBusy}
                                @click=${() => props.onResolveExecApproval(entry.id, "allow-once")}
                              >
                                Allow once
                              </button>
                              <button
                                class="btn btn--sm"
                                type="button"
                                ?disabled=${props.execApprovalBusy}
                                @click=${() => props.onResolveExecApproval(entry.id, "allow-always")}
                              >
                                Always allow
                              </button>
                              <button
                                class="btn btn--sm"
                                type="button"
                                ?disabled=${props.execApprovalBusy}
                                @click=${() => props.onResolveExecApproval(entry.id, "deny")}
                              >
                                Deny
                              </button>
                            </div>
                          </div>
                          <div class="mission-row__meta mission-row__meta--stack">
                            ${entry.request.security ? renderToneBadge(entry.request.security, "warn") : nothing}
                            <span>Expires ${formatRelativeTimestamp(entry.expiresAtMs)}</span>
                          </div>
                        </div>
                      `,
                    )
              }
            </section>
            <section class="mission-subpanel">
              <div class="mission-subpanel__title">Pending devices</div>
              ${
                pendingDevices.length === 0
                  ? renderEmptyState(
                      pendingDeviceCount > 0
                        ? `${formatCount(pendingDeviceCount)} pairing requests pending, detail snapshot not loaded yet.`
                        : `No pairing requests. ${formatCount(pairedDeviceCount)} device(s) already paired.`,
                    )
                  : pendingDevices.slice(0, 4).map(
                      (entry) => html`
                        <div class="mission-row">
                          <div class="mission-row__body">
                            <div class="mission-row__title">${entry.displayName ?? entry.deviceId}</div>
                            <div class="mission-row__detail">
                              ${entry.role ?? "role unknown"}
                              ${entry.remoteIp ? html` · ${entry.remoteIp}` : nothing}
                              ${
                                entry.isRepair
                                  ? html`
                                      · repair
                                    `
                                  : nothing
                              }
                            </div>
                            <div class="mission-actions-inline">
                              <button
                                class="btn btn--sm"
                                type="button"
                                ?disabled=${props.devicesLoading}
                                @click=${() => props.onApproveDevice(entry.requestId)}
                              >
                                Pair device
                              </button>
                              <button
                                class="btn btn--sm"
                                type="button"
                                ?disabled=${props.devicesLoading}
                                @click=${() => props.onRejectDevice(entry.requestId)}
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                          <div class="mission-row__meta">${entry.ts ? formatRelativeTimestamp(entry.ts) : "Pending"}</div>
                        </div>
                      `,
                    )
              }
            </section>
            <section class="mission-subpanel">
              <div class="mission-subpanel__title">Watch items</div>
              ${
                alerts.length === 0
                  ? renderEmptyState("No active watch items.")
                  : alerts.map(
                      (alert) => html`
                        <div class="mission-row mission-row--tight ${toneClass(alert.tone)}">
                          <div>
                            <div class="mission-row__title">${alert.title}</div>
                            <div class="mission-row__detail">${alert.detail}</div>
                          </div>
                        </div>
                      `,
                    )
              }
            </section>
          </div>
        </article>

        <article class="card mission-panel mission-panel--span-7">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Incident Drill-Down</div>
              <div class="card-sub">One alert, multiple pivots into logs, sessions, agents, channels, and runtime surfaces.</div>
            </div>
            <button class="btn btn--sm" type="button" @click=${() => props.onOpenLogsQuery("error")}>Open error logs</button>
          </div>
          <div class="mission-stack">
            ${
              incidents.length === 0
                ? renderEmptyState("No incidents require drill-down right now.")
                : incidents.map(
                    (incident) => html`
                      <div class="mission-row ${toneClass(incident.tone)}">
                        <div class="mission-row__body">
                          <div class="mission-row__title">${incident.title}</div>
                          <div class="mission-row__detail">${incident.detail}</div>
                          ${renderIncidentContext(incident)}
                          <div class="mission-actions-inline">
                            ${
                              incident.backendManaged && incident.status === "open"
                                ? html`
                                    <button
                                      class="btn btn--sm"
                                      type="button"
                                      ?disabled=${props.dashboardLoading}
                                      @click=${() => props.onAckIncident(incident.id)}
                                    >
                                      Ack
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              incident.backendManaged && incident.status !== "resolved"
                                ? html`
                                    <button
                                      class="btn btn--sm"
                                      type="button"
                                      ?disabled=${props.dashboardLoading}
                                      @click=${() => props.onResolveIncident(incident.id)}
                                    >
                                      Resolve
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              incident.logQuery
                                ? html`
                                    <button class="btn btn--sm" type="button" @click=${() => props.onOpenLogsQuery(incident.logQuery ?? "")}>
                                      Logs
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              incident.sessionKey
                                ? html`
                                    <button class="btn btn--sm" type="button" @click=${() => props.onOpenSession(incident.sessionKey ?? "")}>
                                      Session
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              incident.agentId
                                ? html`
                                    <button class="btn btn--sm" type="button" @click=${() => props.onFocusAgent(incident.agentId ?? "")}>
                                      Agent
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              incident.channelId
                                ? html`
                                    <button class="btn btn--sm" type="button" @click=${() => props.onFocusChannel(incident.channelId ?? "")}>
                                      Channel
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              incident.nodeId
                                ? html`
                                    <button class="btn btn--sm" type="button" @click=${() => props.onFocusNode(incident.nodeId ?? "")}>
                                      Node
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              incident.actionTab
                                ? html`
                                    <button class="btn btn--sm" type="button" @click=${() => props.onNavigate(incident.actionTab ?? "overview")}>
                                      ${incident.actionLabel ?? "Open"}
                                    </button>
                                  `
                                : nothing
                            }
                          </div>
                        </div>
                        <div class="mission-row__meta">
                          ${
                            incident.status
                              ? renderToneBadge(
                                  incident.status,
                                  incident.status === "open"
                                    ? incident.tone
                                    : incident.status === "acked"
                                      ? "info"
                                      : "muted",
                                )
                              : nothing
                          }
                          ${renderToneBadge(incident.tone, incident.tone)}
                        </div>
                      </div>
                    `,
                  )
            }
          </div>
        </article>

        <article class="card mission-panel mission-panel--span-5">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Node Ops</div>
              <div class="card-sub">Direct ping, inspect, log pivot, and doctor actions against paired nodes.</div>
            </div>
            <button class="btn btn--sm" type="button" @click=${() => props.onNavigate("nodes")}>Open nodes</button>
          </div>
          <div class="mission-stack">
            ${
              nodeCards.length === 0
                ? renderEmptyState("No node snapshot available.")
                : nodeCards.map((node) => {
                    const busy = props.missionNodeBusyById[node.nodeId] ?? null;
                    const canProbe = node.commands.includes("system.which");
                    const canDoctor = node.commands.includes("system.run") && node.connected;
                    return html`
                      <div class="mission-row ${toneClass(node.tone)}">
                        <div class="mission-row__body">
                          <div class="mission-row__title">${node.label}</div>
                          <div class="mission-row__detail">${node.detail}</div>
                          <div class="mission-actions-inline">
                            <button class="btn btn--sm" type="button" ?disabled=${Boolean(busy)} @click=${() => props.onDescribeNode(node.nodeId)}>
                              ${busy === "describe" ? "Loading…" : "Describe"}
                            </button>
                            <button class="btn btn--sm" type="button" ?disabled=${Boolean(busy) || !canProbe} @click=${() => props.onProbeNode(node.nodeId)}>
                              ${busy === "probe" ? "Pinging…" : "Ping"}
                            </button>
                            <button class="btn btn--sm" type="button" ?disabled=${Boolean(busy) || !canDoctor} @click=${() => props.onRunNodeDoctor(node.nodeId)}>
                              ${busy === "doctor" ? "Running…" : busy === "approval" ? "Awaiting approval" : "Doctor"}
                            </button>
                            <button class="btn btn--sm" type="button" @click=${() => props.onOpenLogsQuery(node.nodeId)}>
                              Logs
                            </button>
                            <button class="btn btn--sm" type="button" @click=${() => props.onFocusNode(node.nodeId)}>
                              Node
                            </button>
                          </div>
                        </div>
                        <div class="mission-row__meta mission-row__meta--stack">
                          ${renderToneBadge(node.connected ? "connected" : node.paired ? "paired" : "offline", node.tone)}
                          <span class="mono">${node.nodeId}</span>
                        </div>
                      </div>
                    `;
                  })
            }
            ${
              props.missionNodeResult
                ? html`
                    <div class="mission-inline-note ${toneClass(props.missionNodeResult.status)}">
                      <strong>${props.missionNodeResult.title}</strong><br />
                      ${props.missionNodeResult.detail}
                      ${
                        props.missionNodeResult.output
                          ? html`<pre class="mission-inline-pre">${props.missionNodeResult.output}</pre>`
                          : nothing
                      }
                    </div>
                  `
                : nothing
            }
          </div>
        </article>

        <article class="card mission-panel mission-panel--span-7">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Hot Sessions</div>
              <div class="card-sub">Recent, aborted, high-context, and cron-driven sessions.</div>
            </div>
            <button class="btn btn--sm" type="button" @click=${() => props.onNavigate("sessions")}>Open sessions</button>
          </div>
          <div class="mission-list">
            ${
              hotSessions.length === 0
                ? renderEmptyState("No active sessions available.")
                : hotSessions.map(
                    (row) => html`
                      <button class="mission-list__item" type="button" @click=${() => props.onOpenSession(row.key)}>
                        <div class="mission-list__main">
                          <div class="mission-list__title">${row.key}</div>
                          <div class="mission-list__detail">
                            ${row.model ?? "model n/a"} · ${formatSessionTokens(row.totalTokens ?? null, row.contextTokens ?? null)}
                          </div>
                        </div>
                        <div class="mission-list__meta">
                          ${renderToneBadge(row.kind, resolveSessionTone(row))}
                          <span>${formatRelativeOrNa(row.updatedAt)}</span>
                          ${
                            row.abortedLastRun
                              ? html`
                                  <span class="muted">Aborted last run</span>
                                `
                              : nothing
                          }
                        </div>
                      </button>
                    `,
                  )
            }
          </div>
        </article>

        <article class="card mission-panel mission-panel--span-5">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Channel Health</div>
              <div class="card-sub">Configuration, link state, and recent activity per inbox.</div>
            </div>
            <button class="btn btn--sm" type="button" @click=${() => props.onNavigate("channels")}>Open channels</button>
          </div>
          <div class="mission-channel-grid">
            ${
              channelCards.length === 0
                ? renderEmptyState("No channel snapshot available yet.")
                : channelCards.map(
                    (channel) => html`
                      <div class="mission-channel ${toneClass(channel.tone)}">
                        <div class="mission-channel__head">
                          <div class="mission-channel__title">${channel.label}</div>
                          ${renderToneBadge(channel.summary, channel.tone)}
                        </div>
                        <div class="mission-channel__detail">${channel.detail}</div>
                        <div class="mission-channel__meta">
                          <span>${formatCount(channel.accountCount)} account(s)</span>
                          <span>${formatLastActivity(channel.lastActivityAt)}</span>
                        </div>
                      </div>
                    `,
                  )
            }
          </div>
        </article>
        <article class="card mission-panel mission-panel--span-6">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Cron Watch</div>
              <div class="card-sub">Upcoming schedules, last failures, and run pressure.</div>
            </div>
            <button class="btn btn--sm" type="button" @click=${() => props.onNavigate("cron")}>Open cron</button>
          </div>
          <div class="mission-stack">
            <div class="mission-row mission-row--tight">
              <div>
                <div class="mission-row__title">Scheduler state</div>
                <div class="mission-row__detail">
                  ${props.cronStatus?.enabled ? "Enabled" : "Disabled"} · Next wake ${formatNextRun(props.cronStatus?.nextWakeAtMs ?? null)}
                </div>
              </div>
              <div class="mission-row__meta">${formatCount(failingCronJobs.length)} failing</div>
            </div>
              ${
                props.cronJobs.length === 0
                  ? renderEmptyState("No cron jobs configured.")
                  : props.cronJobs
                      .toSorted(
                        (left, right) =>
                          (right.state?.nextRunAtMs ?? 0) - (left.state?.nextRunAtMs ?? 0),
                      )
                      .slice(0, 6)
                      .map(
                        (job) => html`
                        <div class="mission-row">
                          <div class="mission-row__body">
                            <div class="mission-row__title">${job.name}</div>
                            <div class="mission-row__detail">
                              ${
                                job.payload.kind === "agentTurn"
                                  ? clampText(job.payload.message, 84)
                                  : clampText(job.payload.text, 84)
                              }
                            </div>
                            <div class="mission-actions-inline">
                              <button
                                class="btn btn--sm"
                                type="button"
                                ?disabled=${props.cronBusy}
                                @click=${() => props.onRunCronJob(job.id)}
                              >
                                Run now
                              </button>
                            </div>
                          </div>
                          <div class="mission-row__meta">
                            ${renderToneBadge(
                              job.state?.lastStatus ?? (job.enabled ? "queued" : "paused"),
                              job.state?.lastStatus === "error"
                                ? "danger"
                                : job.enabled
                                  ? "info"
                                  : "muted",
                            )}
                            <span>${formatNextRun(job.state?.nextRunAtMs ?? null)}</span>
                          </div>
                        </div>
                      `,
                      )
              }
          </div>
        </article>

        <article class="card mission-panel mission-panel--span-6">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Usage Snapshot</div>
              <div class="card-sub">Current usage window ${props.usageStartDate} to ${props.usageEndDate}.</div>
            </div>
            <button class="btn btn--sm" type="button" @click=${() => props.onNavigate("usage")}>Open usage</button>
          </div>
          <div class="mission-usage-grid">
            <div class="mission-usage-stat">
              <div class="mission-usage-stat__label">Cost</div>
              <div class="mission-usage-stat__value">${formatMoney(usage.totalCost)}</div>
            </div>
            <div class="mission-usage-stat">
              <div class="mission-usage-stat__label">Tokens</div>
              <div class="mission-usage-stat__value">${formatCompactCount(usage.totalTokens)}</div>
            </div>
            <div class="mission-usage-stat">
              <div class="mission-usage-stat__label">Sessions</div>
              <div class="mission-usage-stat__value">${formatCount(usage.sessions)}</div>
            </div>
            <div class="mission-usage-stat">
              <div class="mission-usage-stat__label">Messages</div>
              <div class="mission-usage-stat__value">${formatCompactCount(usage.messages)}</div>
            </div>
          </div>
          <div class="mission-stack">
            <div class="mission-row mission-row--tight">
              <div>
                <div class="mission-row__title">Top agent</div>
                <div class="mission-row__detail">${usage.topAgent ?? "No usage data yet."}</div>
              </div>
              <div class="mission-row__meta">Errors ${formatCount(usage.errors)}</div>
            </div>
            <div class="mission-row mission-row--tight">
              <div>
                <div class="mission-row__title">Top tool</div>
                <div class="mission-row__detail">${usage.topTool ?? "No tool calls in range."}</div>
              </div>
              <div class="mission-row__meta">P95 ${usage.latencyP95Ms != null ? `${Math.round(usage.latencyP95Ms)}ms` : "n/a"}</div>
            </div>
            <div class="mission-row mission-row--tight">
              <div>
                <div class="mission-row__title">Top model</div>
                <div class="mission-row__detail">${usage.topModel ?? "No model activity in range."}</div>
              </div>
              <div class="mission-row__meta">${props.usageStartDate === props.usageEndDate ? "1 day" : "custom"} window</div>
            </div>
          </div>
          <section class="mission-subpanel">
            <div class="mission-subpanel__title">15-minute drift</div>
            ${renderMissionTrendCards(dashboardTimeline)}
          </section>
        </article>

        <article class="card mission-panel mission-panel--span-6">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Security Posture</div>
              <div class="card-sub">Cached gateway audit with prioritized findings and remediation cues.</div>
            </div>
            <div class="mission-actions-inline">
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.dashboardLoading}
                @click=${() => props.onRefreshSecurityAudit()}
              >
                Refresh audit
              </button>
              <button class="btn btn--sm" type="button" @click=${() => props.onNavigate("config")}>Open config</button>
            </div>
          </div>
          <div class="mission-usage-grid">
            <div class="mission-usage-stat">
              <div class="mission-usage-stat__label">Critical</div>
              <div class="mission-usage-stat__value">${formatCount(securitySummary?.critical ?? 0)}</div>
              <div class="mission-usage-stat__detail">Immediate review required</div>
            </div>
            <div class="mission-usage-stat">
              <div class="mission-usage-stat__label">Warnings</div>
              <div class="mission-usage-stat__value">${formatCount(securitySummary?.warn ?? 0)}</div>
              <div class="mission-usage-stat__detail">Operational hardening</div>
            </div>
            <div class="mission-usage-stat">
              <div class="mission-usage-stat__label">Info</div>
              <div class="mission-usage-stat__value">${formatCount(securitySummary?.info ?? 0)}</div>
              <div class="mission-usage-stat__detail">Background recommendations</div>
            </div>
            <div class="mission-usage-stat">
              <div class="mission-usage-stat__label">Audit state</div>
              <div class="mission-usage-stat__value">
                ${props.dashboardLoading ? "Refreshing" : dashboard?.security.cached ? "Cached" : dashboard ? "Fresh" : "n/a"}
              </div>
              <div class="mission-usage-stat__detail">
                ${dashboard?.security.ts ? formatRelativeTimestamp(dashboard.security.ts) : "No audit timestamp"}
              </div>
            </div>
          </div>
          <div class="mission-stack">
            ${
              props.dashboardError
                ? html`<div class="mission-inline-note mission-tone-warn">${clampText(props.dashboardError, 180)}</div>`
                : nothing
            }
            ${
              securityFindings.length === 0
                ? renderEmptyState(
                    securitySummary
                      ? "No critical or warning findings in the latest audit."
                      : "Security audit summary unavailable.",
                  )
                : securityFindings.map(
                    (finding) => html`
                      <div class="mission-row ${toneClass(securityFindingTone(finding.severity))}">
                        <div>
                          <div class="mission-row__title">${finding.title}</div>
                          <div class="mission-row__detail">${finding.detail}</div>
                          ${
                            finding.remediation
                              ? html`<div class="mission-inline-note">${finding.remediation}</div>`
                              : nothing
                          }
                        </div>
                        <div class="mission-row__meta">
                          ${renderToneBadge(finding.severity, securityFindingTone(finding.severity))}
                        </div>
                      </div>
                    `,
                  )
            }
          </div>
        </article>

        <article class="card mission-panel mission-panel--span-6">
          <div class="mission-panel__header">
            <div>
              <div class="card-title">Runtime Pulse</div>
              <div class="card-sub">Presence, heartbeat cadence, queue pressure, and queued system events.</div>
            </div>
            <button class="btn btn--sm" type="button" @click=${() => props.onNavigate("instances")}>Open instances</button>
          </div>
          <div class="mission-stack">
            <section class="mission-subpanel">
              <div class="mission-subpanel__title">Queue pressure</div>
              <div class="mission-usage-grid">
                <div class="mission-usage-stat">
                  <div class="mission-usage-stat__label">Command queue</div>
                  <div class="mission-usage-stat__value">${formatCount(runtimeBacklog?.queueSize ?? 0)}</div>
                </div>
                <div class="mission-usage-stat">
                  <div class="mission-usage-stat__label">Pending replies</div>
                  <div class="mission-usage-stat__value">${formatCount(runtimeBacklog?.pendingReplies ?? 0)}</div>
                </div>
                <div class="mission-usage-stat">
                  <div class="mission-usage-stat__label">Embedded runs</div>
                  <div class="mission-usage-stat__value">${formatCount(runtimeBacklog?.activeEmbeddedRuns ?? 0)}</div>
                </div>
                <div class="mission-usage-stat">
                  <div class="mission-usage-stat__label">Connected nodes</div>
                  <div class="mission-usage-stat__value">${formatCount(nodeCount)}</div>
                  <div class="mission-usage-stat__detail">
                    ${hasMobileNodeConnected ? "Mobile node connected" : "No mobile node connected"}
                  </div>
                </div>
              </div>
            </section>
            <section class="mission-subpanel">
              <div class="mission-subpanel__title">Heartbeat</div>
              ${
                heartbeatAgents.length === 0
                  ? renderEmptyState("No heartbeat configuration reported.")
                  : heartbeatAgents.map(
                      (entry) => html`
                        <div class="mission-row mission-row--tight">
                          <div>
                            <div class="mission-row__title">${entry.agentId ?? "agent"}</div>
                            <div class="mission-row__detail">${entry.enabled ? (entry.every ?? "enabled") : "disabled"}</div>
                          </div>
                          <div class="mission-row__meta">
                            ${renderToneBadge(entry.enabled ? "active" : "disabled", entry.enabled ? "ok" : "muted")}
                          </div>
                        </div>
                      `,
                    )
              }
              ${
                lastHeartbeat
                  ? html`
                      <div class="mission-inline-note">
                        Last heartbeat: ${lastHeartbeat.status} ${formatRelativeTimestamp(lastHeartbeat.ts)}
                        ${lastHeartbeat.channel ? html` · ${lastHeartbeat.channel}` : nothing}
                        ${lastHeartbeat.accountId ? html` · ${lastHeartbeat.accountId}` : nothing}
                      </div>
                    `
                  : nothing
              }
            </section>
            <section class="mission-subpanel">
              <div class="mission-subpanel__title">Presence</div>
              ${
                props.presenceEntries.length === 0
                  ? renderEmptyState(props.presenceStatus ?? "No presence beacons available.")
                  : props.presenceEntries.slice(0, 5).map(
                      (entry) => html`
                        <div class="mission-row mission-row--tight">
                          <div>
                            <div class="mission-row__title">${entry.host ?? entry.instanceId ?? "instance"}</div>
                            <div class="mission-row__detail">
                              ${entry.mode ?? "mode n/a"}
                              ${entry.version ? html` · ${entry.version}` : nothing}
                              ${entry.platform ? html` · ${entry.platform}` : nothing}
                            </div>
                          </div>
                          <div class="mission-row__meta">${entry.ts ? formatRelativeTimestamp(entry.ts) : "n/a"}</div>
                        </div>
                      `,
                    )
              }
            </section>
            <section class="mission-subpanel">
              <div class="mission-subpanel__title">Queued system events</div>
              ${
                queuedSystemEvents.length === 0
                  ? renderEmptyState("No queued system events.")
                  : queuedSystemEvents
                      .slice(0, 5)
                      .map((entry) => html`<div class="mission-inline-note">${entry}</div>`)
              }
            </section>
          </div>
        </article>

        <article class="card mission-panel mission-panel--span-6">
          ${renderMissionAccess(props, authMode, tickLabel, uptimeLabel)}
        </article>
      </section>
    </section>
  `;
}
