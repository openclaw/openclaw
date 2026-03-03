import { html } from "lit";
import { formatDurationHuman, formatRelativeTimestamp } from "../format.ts";
import { normalizeMessage } from "../chat/message-normalizer.ts";
import type { EventLogEntry } from "../app-events.ts";
import type {
  AgentsListResult,
  ChannelsStatusSnapshot,
  CronStatus,
  GatewaySessionRow,
  GatewayAgentRow,
  PresenceEntry,
  SessionsListResult,
} from "../types.ts";

export type MissionControlProps = {
  connected: boolean;
  hello: { snapshot?: Record<string, unknown> } | null;
  lastError: string | null;
  presenceEntries: PresenceEntry[];
  sessionsResult: SessionsListResult | null;
  agentsList: AgentsListResult | null;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  cronStatus: CronStatus | null;
  chatRunId: string | null;
  chatStream: string | null;
  chatDraft: string;
  chatSending: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  eventLog: EventLogEntry[];
  onRefresh: () => void;
  onDisableMissionMode: () => void;
  onOpenChat: () => void;
  onChatDraftChange: (next: string) => void;
  onSendChat: () => void;
};

type ProcessState = "ok" | "warn" | "down";
type TraceTone = "ok" | "warn" | "down" | "run";

type ProcessRow = {
  name: string;
  detail: string;
  state: ProcessState;
};

type TraceRow = {
  id: string;
  ts: number;
  title: string;
  detail: string;
  source: string;
  tone: TraceTone;
};

type SpawnEdge = {
  id: string;
  ts: number;
  parentRunId: string;
  childRunId: string | null;
  childSessionKey: string | null;
};

type RunSnapshot = {
  runId: string;
  state: string;
  ts: number;
  sessionKey: string | null;
};

type SubagentNode = {
  id: string;
  label: string;
  status: TraceTone;
  statusLabel: string;
  detail: string;
};

type SubagentTree = {
  parentRunId: string;
  parentState: TraceTone;
  parentStateLabel: string;
  children: SubagentNode[];
  reportCount: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summarize(value: string, limit = 140): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}...`;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function inferToneFromText(value: string): TraceTone {
  const text = value.toLowerCase();
  if (
    text.includes("error") ||
    text.includes("failed") ||
    text.includes("blocked") ||
    text.includes("denied")
  ) {
    return "down";
  }
  if (text.includes("running") || text.includes("start")) {
    return "run";
  }
  if (text.includes("ok") || text.includes("success") || text.includes("completed")) {
    return "ok";
  }
  return "warn";
}

function collectTextContent(items: unknown[]): string | null {
  const parts = items
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : null;
    })
    .filter((value): value is string => Boolean(value));
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function normalizeChatState(raw: string): string {
  const state = raw.toLowerCase();
  if (state === "final") {
    return "completed";
  }
  if (state === "error") {
    return "error";
  }
  if (state === "aborted") {
    return "aborted";
  }
  if (state === "start" || state === "stream" || state === "delta") {
    return "running";
  }
  return state || "update";
}

function toneForState(raw: string): TraceTone {
  const state = normalizeChatState(raw);
  if (state === "error") {
    return "down";
  }
  if (state === "aborted") {
    return "warn";
  }
  if (state === "completed") {
    return "ok";
  }
  return "run";
}

function stateLabel(raw: string): string {
  const state = normalizeChatState(raw);
  if (state === "completed") {
    return "completed";
  }
  if (state === "error") {
    return "error";
  }
  if (state === "aborted") {
    return "aborted";
  }
  if (state === "running") {
    return "running";
  }
  return state;
}

function buildToolTraceRows(
  toolMessages: unknown[],
): { rows: TraceRow[]; activeTools: number; spawns: SpawnEdge[] } {
  const rows: TraceRow[] = [];
  let activeTools = 0;
  const spawns: SpawnEdge[] = [];

  toolMessages.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const record = raw as Record<string, unknown>;
    const toolCallId =
      typeof record.toolCallId === "string" ? record.toolCallId : `tool-${index + 1}`;
    const ts = typeof record.timestamp === "number" ? record.timestamp : Date.now();
    const runId = typeof record.runId === "string" ? record.runId : "unknown-run";
    const content = Array.isArray(record.content) ? record.content : [];

    let toolName = "tool";
    let output: string | null = null;
    for (const item of content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const entry = item as Record<string, unknown>;
      const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
      if ((type === "toolcall" || type === "tool_call") && typeof entry.name === "string") {
        toolName = entry.name;
      }
      if ((type === "toolresult" || type === "tool_result") && typeof entry.text === "string") {
        output = entry.text;
      }
    }

    if (!output) {
      activeTools += 1;
      rows.push({
        id: `tool:${toolCallId}:running`,
        ts,
        title: `${toolName} running`,
        detail: "Tool call in progress...",
        source: summarize(runId, 22),
        tone: "run",
      });
      return;
    }

    const parsed = parseJsonObject(output);
    if (toolName === "sessions_spawn" && parsed) {
      const childSessionKey =
        typeof parsed.childSessionKey === "string" ? parsed.childSessionKey : null;
      const spawnedRunId = typeof parsed.runId === "string" ? parsed.runId : null;
      if (childSessionKey || spawnedRunId) {
        spawns.push({
          id: `${toolCallId}:spawn`,
          ts,
          parentRunId: runId,
          childRunId: spawnedRunId,
          childSessionKey,
        });
        const parts: string[] = [];
        if (childSessionKey) {
          parts.push(`agent=${summarize(childSessionKey, 46)}`);
        }
        if (spawnedRunId) {
          parts.push(`run=${summarize(spawnedRunId, 22)}`);
        }
        rows.push({
          id: `tool:${toolCallId}:spawn`,
          ts,
          title: "Subagent spawned",
          detail: parts.join(" • "),
          source: summarize(runId, 22),
          tone: "ok",
        });
        return;
      }
    }

    const detail = summarize(output);
    rows.push({
      id: `tool:${toolCallId}:result`,
      ts,
      title: `${toolName} result`,
      detail,
      source: summarize(runId, 22),
      tone: inferToneFromText(detail),
    });
  });

  return { rows, activeTools, spawns };
}

function buildChatTraceRows(chatMessages: unknown[]): TraceRow[] {
  const rows: TraceRow[] = [];

  chatMessages.forEach((raw, index) => {
    const message = normalizeMessage(raw);
    const role = message.role.toLowerCase();
    if (role === "user") {
      return;
    }
    const text = collectTextContent(message.content);
    if (!text) {
      return;
    }
    const lower = text.toLowerCase();
    let title: string | null = null;

    if (/\[system message\]/i.test(text) && /subagent task .*completed/i.test(text)) {
      title = "Subagent report delivered";
    } else if (lower.includes("[security alert]")) {
      title = "Security alert";
    } else if (lower.includes("tool_failed") || lower.includes("tool_not_called")) {
      title = "Task completion failure";
    } else if (role === "system") {
      title = "System update";
    }

    if (!title) {
      return;
    }

    rows.push({
      id: `chat:${index + 1}`,
      ts: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      title,
      detail: summarize(text),
      source: role,
      tone: inferToneFromText(text),
    });
  });

  return rows;
}

function buildGatewayTraceRows(eventLog: EventLogEntry[]): TraceRow[] {
  const rows: TraceRow[] = [];

  eventLog.forEach((entry, index) => {
    const event = entry.event;
    if (event === "presence") {
      return;
    }
    if (event === "exec.approval.requested") {
      rows.push({
        id: `event:${index + 1}:approval-requested`,
        ts: entry.ts,
        title: "Approval requested",
        detail: "Sensitive action waiting for operator approval.",
        source: event,
        tone: "warn",
      });
      return;
    }
    if (event === "exec.approval.resolved") {
      rows.push({
        id: `event:${index + 1}:approval-resolved`,
        ts: entry.ts,
        title: "Approval resolved",
        detail: "Approval workflow completed.",
        source: event,
        tone: "ok",
      });
      return;
    }

    if (event === "chat") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      const state = typeof payload?.state === "string" ? payload.state.toLowerCase() : "";
      const runId = typeof payload?.runId === "string" ? payload.runId : "unknown-run";
      const sessionKey =
        typeof payload?.sessionKey === "string" ? summarize(payload.sessionKey, 32) : "unknown";
      const detail = `state=${state || "update"} • run=${summarize(runId, 26)} • session=${sessionKey}`;
      rows.push({
        id: `event:${index + 1}:chat-${state || "update"}`,
        ts: entry.ts,
        title: state === "error" ? "Run error" : state === "aborted" ? "Run aborted" : "Run update",
        detail,
        source: event,
        tone: state === "error" ? "down" : state === "aborted" ? "warn" : "run",
      });
      return;
    }

    if (event === "agent") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      const stream = typeof payload?.stream === "string" ? payload.stream : "agent";
      const runId = typeof payload?.runId === "string" ? payload.runId : "unknown-run";
      const data = payload?.data as Record<string, unknown> | undefined;
      const phase = typeof data?.phase === "string" ? data.phase : "";
      const toolName = typeof data?.name === "string" ? data.name : "";
      const stateText = [stream, phase, toolName].filter(Boolean).join(" • ");
      rows.push({
        id: `event:${index + 1}:agent-${stream}-${phase || "update"}`,
        ts: entry.ts,
        title: "Agent event",
        detail: `${stateText || stream} • run=${summarize(runId, 26)}`,
        source: event,
        tone:
          phase === "result"
            ? "ok"
            : phase === "start" || stream === "tool"
              ? "run"
              : stream === "fallback"
                ? "warn"
                : "warn",
      });
      return;
    }

    rows.push({
      id: `event:${index + 1}:generic`,
      ts: entry.ts,
      title: `Gateway event: ${event}`,
      detail: "Gateway emitted a non-standard update.",
      source: event,
      tone: "warn",
    });
  });

  return rows;
}

function buildRunSnapshots(eventLog: EventLogEntry[]): Map<string, RunSnapshot> {
  const snapshots = new Map<string, RunSnapshot>();

  for (const entry of eventLog) {
    if (entry.event !== "chat") {
      continue;
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    const runId = typeof payload?.runId === "string" ? payload.runId : "";
    if (!runId) {
      continue;
    }
    const state = typeof payload?.state === "string" ? payload.state : "update";
    const sessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey : null;
    const existing = snapshots.get(runId);
    if (existing && existing.ts >= entry.ts) {
      continue;
    }
    snapshots.set(runId, {
      runId,
      state,
      ts: entry.ts,
      sessionKey,
    });
  }

  return snapshots;
}

function buildSubagentTree(
  props: MissionControlProps,
  spawns: SpawnEdge[],
  runSnapshots: Map<string, RunSnapshot>,
): SubagentTree {
  const sessions = props.sessionsResult?.sessions ?? [];
  const activeSessionSubagents = sessions.filter((entry) => entry.key.includes(":subagent:"));
  const fallbackParentRun = Array.from(runSnapshots.values())
    .sort((a, b) => b.ts - a.ts)
    .find((entry) => !entry.sessionKey || !entry.sessionKey.includes(":subagent:"))?.runId;
  const parentRunId = props.chatRunId ?? fallbackParentRun ?? "no-active-run";
  const parentState = toneForState(runSnapshots.get(parentRunId)?.state ?? "running");
  const parentStateLabel = stateLabel(runSnapshots.get(parentRunId)?.state ?? "running");

  const nodes = new Map<string, SubagentNode>();
  for (const spawn of spawns) {
    const childKey = spawn.childRunId ?? spawn.childSessionKey ?? spawn.id;
    if (nodes.has(childKey)) {
      continue;
    }
    const childSnapshot = spawn.childRunId ? runSnapshots.get(spawn.childRunId) : null;
    const tone = toneForState(childSnapshot?.state ?? "running");
    const detailParts: string[] = [];
    if (spawn.childSessionKey) {
      detailParts.push(`session ${summarize(spawn.childSessionKey, 46)}`);
    }
    if (spawn.childRunId) {
      detailParts.push(`run ${summarize(spawn.childRunId, 24)}`);
    }
    detailParts.push(`spawned ${formatRelativeTimestamp(spawn.ts)}`);
    nodes.set(childKey, {
      id: childKey,
      label: spawn.childSessionKey
        ? summarize(spawn.childSessionKey, 52)
        : spawn.childRunId
          ? summarize(spawn.childRunId, 30)
          : "subagent",
      status: tone,
      statusLabel: stateLabel(childSnapshot?.state ?? "running"),
      detail: detailParts.join(" • "),
    });
  }

  for (const session of activeSessionSubagents) {
    const key = session.key;
    if (nodes.has(key)) {
      continue;
    }
    const ts = typeof session.updatedAt === "number" ? session.updatedAt : Date.now();
    const isRecent = Date.now() - ts <= 5 * 60_000;
    nodes.set(key, {
      id: key,
      label: summarize(key, 52),
      status: isRecent ? "run" : "warn",
      statusLabel: isRecent ? "running" : "stale",
      detail: `session observed ${formatRelativeTimestamp(ts)}`,
    });
  }

  const reportCount = props.chatMessages.reduce((count, raw) => {
    const msg = normalizeMessage(raw);
    const text = collectTextContent(msg.content);
    if (!text) {
      return count;
    }
    return /\[system message\]/i.test(text) && /subagent task .*completed/i.test(text)
      ? count + 1
      : count;
  }, 0);

  return {
    parentRunId,
    parentState,
    parentStateLabel,
    children: Array.from(nodes.values()).sort((a, b) => a.label.localeCompare(b.label)),
    reportCount,
  };
}

function resolveActiveSubagents(sessions: GatewaySessionRow[] | undefined): number {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return 0;
  }
  const now = Date.now();
  return sessions.filter((entry) => {
    if (!entry.key.includes(":subagent:")) {
      return false;
    }
    return typeof entry.updatedAt === "number" && now - entry.updatedAt <= 5 * 60_000;
  }).length;
}

function channelCounts(snapshot: ChannelsStatusSnapshot | null): { total: number; active: number } {
  const total = snapshot?.channelOrder?.length ?? 0;
  const active = Object.values(snapshot?.channelAccounts ?? {})
    .flat()
    .filter((entry) => entry.connected || entry.running).length;
  return { total, active };
}

function processRows(props: MissionControlProps): ProcessRow[] {
  const channels = channelCounts(props.channelsSnapshot);
  const sessions = props.sessionsResult?.count ?? 0;
  const cronEnabled = props.cronStatus?.enabled ?? false;
  const agentsCount = props.agentsList?.agents?.length ?? 0;

  return [
    {
      name: "Gateway Link",
      detail: props.connected ? "Authenticated and responsive" : "Disconnected",
      state: props.connected ? "ok" : "down",
    },
    {
      name: "Agent Orchestrator",
      detail: `${agentsCount} agent${agentsCount === 1 ? "" : "s"} registered`,
      state: agentsCount > 0 ? "ok" : "warn",
    },
    {
      name: "Session Bus",
      detail: `${sessions} tracked session${sessions === 1 ? "" : "s"}`,
      state: sessions > 0 ? "ok" : "warn",
    },
    {
      name: "Channel Mesh",
      detail: `${channels.active} active account${channels.active === 1 ? "" : "s"} across ${channels.total} channel${channels.total === 1 ? "" : "s"}`,
      state: channels.total > 0 ? "ok" : "warn",
    },
    {
      name: "Scheduler Core",
      detail: cronEnabled ? "Recurring jobs armed" : "Scheduler paused",
      state: cronEnabled ? "ok" : "warn",
    },
  ];
}

function compactHostLabel(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) {
    return "unknown-host";
  }
  return text.length > 24 ? `${text.slice(0, 24)}...` : text;
}

function renderAgentChip(agent: GatewayAgentRow, defaultId: string | null) {
  const isDefault = defaultId === agent.id;
  return html`
    <div class="mission-chip ${isDefault ? "is-primary" : ""}">
      <span class="mission-chip__name">${agent.id}</span>
      <span class="mission-chip__state">${isDefault ? "primary" : "standby"}</span>
    </div>
  `;
}

function renderProcessRow(row: ProcessRow) {
  return html`
    <div class="mission-process-row">
      <div class="mission-process-row__left">
        <span class="mission-dot ${row.state}"></span>
        <span class="mission-process-row__name">${row.name}</span>
      </div>
      <span class="mission-process-row__detail">${row.detail}</span>
    </div>
  `;
}

export function renderMissionControl(props: MissionControlProps) {
  const snapshot = props.hello?.snapshot as
    | {
        uptimeMs?: number;
        policy?: { tickIntervalMs?: number };
      }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationHuman(snapshot.uptimeMs) : "n/a";
  const tick = snapshot?.policy?.tickIntervalMs ? `${snapshot.policy.tickIntervalMs}ms` : "n/a";

  const channels = channelCounts(props.channelsSnapshot);
  const agents = props.agentsList?.agents ?? [];
  const defaultAgentId = props.agentsList?.defaultId ?? null;
  const sessionRows = props.sessionsResult?.sessions;
  const instanceLead = props.presenceEntries[0];
  const leadHost = compactHostLabel(instanceLead?.host);
  const leadSeen = instanceLead?.ts ? formatRelativeTimestamp(instanceLead.ts) : "n/a";

  const sessionCount = props.sessionsResult?.count ?? 0;
  const cronJobs = props.cronStatus?.jobs ?? 0;
  const cronNext = props.cronStatus?.nextWakeAtMs
    ? formatRelativeTimestamp(props.cronStatus.nextWakeAtMs)
    : "n/a";
  const activeSubagents = resolveActiveSubagents(sessionRows);
  const toolTrace = buildToolTraceRows(props.chatToolMessages);
  const chatTrace = buildChatTraceRows(props.chatMessages);
  const gatewayTrace = buildGatewayTraceRows(props.eventLog);
  const runSnapshots = buildRunSnapshots(props.eventLog);
  const subagentTree = buildSubagentTree(props, toolTrace.spawns, runSnapshots);
  const traceRows = [...toolTrace.rows, ...chatTrace, ...gatewayTrace]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 18);
  const liveRunLabel = props.chatRunId ? summarize(props.chatRunId, 26) : "idle";
  const liveStreamLabel = props.chatStream ? summarize(props.chatStream, 32) : "waiting";
  const latestGatewayEvent = props.eventLog[0];
  const latestGatewayLabel = latestGatewayEvent
    ? `${latestGatewayEvent.event} ${formatRelativeTimestamp(latestGatewayEvent.ts)}`
    : "no event yet";
  const canSendCommand = props.connected && !props.chatSending && props.chatDraft.trim().length > 0;

  return html`
    <section class="mission-shell">
      <div class="mission-hero card">
        <div class="mission-hero__glow" aria-hidden="true"></div>
        <div class="mission-hero__header">
          <div>
            <div class="mission-eyebrow">Mission Control</div>
            <div class="mission-title">Realtime Operator Grid</div>
            <div class="mission-subtitle">
              Live topology for gateway health, agent orchestration, and process flow.
            </div>
          </div>
          <div class="mission-actions">
            <button class="btn btn--sm" @click=${props.onRefresh}>Refresh telemetry</button>
            <button class="btn btn--sm mission-btn-ghost" @click=${props.onDisableMissionMode}
              >Classic overview</button
            >
          </div>
        </div>
        <div class="mission-kpi-grid">
          <div class="mission-kpi">
            <div class="mission-kpi__label">Gateway</div>
            <div class="mission-kpi__value ${props.connected ? "ok" : "down"}">
              ${props.connected ? "ONLINE" : "OFFLINE"}
            </div>
            <div class="mission-kpi__meta">tick ${tick}</div>
          </div>
          <div class="mission-kpi">
            <div class="mission-kpi__label">Uptime</div>
            <div class="mission-kpi__value">${uptime}</div>
            <div class="mission-kpi__meta">lead node ${leadHost}</div>
          </div>
          <div class="mission-kpi">
            <div class="mission-kpi__label">Agents</div>
            <div class="mission-kpi__value">${agents.length}</div>
            <div class="mission-kpi__meta">default ${defaultAgentId ?? "n/a"}</div>
          </div>
          <div class="mission-kpi">
            <div class="mission-kpi__label">Channels</div>
            <div class="mission-kpi__value">${channels.active}/${channels.total}</div>
            <div class="mission-kpi__meta">active accounts</div>
          </div>
        </div>
      </div>

      <div class="mission-grid">
        <section class="mission-map card">
          <div class="mission-section-title">System Topology</div>
          <div class="mission-map__canvas">
            <svg class="mission-map__links" viewBox="0 0 640 290" preserveAspectRatio="none">
              <path d="M322 140 L138 70" />
              <path d="M322 140 L138 225" />
              <path d="M322 140 L502 65" />
              <path d="M322 140 L502 225" />
              <path d="M322 140 L322 34" />
            </svg>
            <div class="mission-node mission-node--core">
              <div class="mission-node__name">Gateway Core</div>
              <div class="mission-node__meta">ws+events</div>
            </div>
            <div class="mission-node mission-node--nw">
              <div class="mission-node__name">Channels</div>
              <div class="mission-node__meta">${channels.total} linked</div>
            </div>
            <div class="mission-node mission-node--sw">
              <div class="mission-node__name">Sessions</div>
              <div class="mission-node__meta">${sessionCount} active</div>
            </div>
            <div class="mission-node mission-node--ne">
              <div class="mission-node__name">Agents</div>
              <div class="mission-node__meta">${agents.length} loaded</div>
            </div>
            <div class="mission-node mission-node--se">
              <div class="mission-node__name">Scheduler</div>
              <div class="mission-node__meta">${cronJobs} job${cronJobs === 1 ? "" : "s"}</div>
            </div>
            <div class="mission-node mission-node--n">
              <div class="mission-node__name">Presence</div>
              <div class="mission-node__meta">${props.presenceEntries.length} node${props.presenceEntries.length === 1 ? "" : "s"}</div>
            </div>
          </div>
          <div class="mission-map__footer">
            <span>Lead node seen ${leadSeen}</span>
            <span>Cron next wake ${cronNext}</span>
          </div>
        </section>

        <section class="mission-process card">
          <div class="mission-section-title">Running Processes</div>
          <div class="mission-process-list">${processRows(props).map((row) => renderProcessRow(row))}</div>
          ${
            props.lastError
              ? html`<div class="callout danger mission-callout">${props.lastError}</div>`
              : html`<div class="mission-note">No blocking gateway errors in the latest snapshot.</div>`
          }
        </section>

        <section class="mission-trace card">
          <div class="mission-section-title">Live Ball-by-Ball Trace</div>
          <div class="mission-trace-toolbar">
            <div class="mission-trace-kpis">
              <span class="mission-trace-pill ${props.chatRunId ? "is-live" : ""}"
                >run ${liveRunLabel}</span
              >
              <span class="mission-trace-pill">stream ${liveStreamLabel}</span>
              <span class="mission-trace-pill">events ${props.eventLog.length}</span>
              <span class="mission-trace-pill">last ${summarize(latestGatewayLabel, 42)}</span>
              <span class="mission-trace-pill">tools running ${toolTrace.activeTools}</span>
              <span class="mission-trace-pill">subagents active ${activeSubagents}</span>
            </div>
            <button class="btn btn--sm" @click=${props.onOpenChat}>Open chat stream</button>
          </div>
          <div class="mission-trace-list">
            ${
              traceRows.length
                ? traceRows.map(
                    (row) => html`
                      <article class="mission-trace-item tone-${row.tone}">
                        <div class="mission-trace-item__header">
                          <div class="mission-trace-item__title">${row.title}</div>
                          <div class="mission-trace-item__time">
                            ${formatRelativeTimestamp(row.ts)}
                          </div>
                        </div>
                        <div class="mission-trace-item__detail">${row.detail}</div>
                        <div class="mission-trace-item__source">${row.source}</div>
                      </article>
                    `,
                  )
                : html`<div class="mission-note">No recent execution events yet. Run a task to see live flow.</div>`
            }
          </div>
        </section>

        <section class="mission-subagents card">
          <div class="mission-section-title">Subagent Tree</div>
          <div class="mission-subagents-root">
            <span class="mission-subagents-root__label">Parent run</span>
            <span class="mission-subagents-root__value">${summarize(subagentTree.parentRunId, 42)}</span>
            <span class="mission-dot ${subagentTree.parentState}"></span>
            <span class="mission-subagents-root__state">${subagentTree.parentStateLabel}</span>
          </div>
          <div class="mission-subagents-list">
            ${
              subagentTree.children.length
                ? subagentTree.children.map(
                    (child) => html`
                      <article class="mission-subagent-item tone-${child.status}">
                        <div class="mission-subagent-item__header">
                          <span class="mission-subagent-item__name">${child.label}</span>
                          <span class="mission-subagent-item__state">${child.statusLabel}</span>
                        </div>
                        <div class="mission-subagent-item__detail">${child.detail}</div>
                      </article>
                    `,
                  )
                : html`<div class="mission-note">No spawned subagents yet in this run.</div>`
            }
          </div>
          <div class="mission-note">Subagent reports delivered: ${subagentTree.reportCount}</div>
        </section>

        <section class="mission-command card">
          <div class="mission-section-title">Mission Command Uplink</div>
          <div class="mission-command-row">
            <textarea
              class="mission-command-input"
              .value=${props.chatDraft}
              placeholder="Type a command for MaxBot from Mission Control..."
              @input=${(event: Event) =>
                props.onChatDraftChange((event.target as HTMLTextAreaElement).value)}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (canSendCommand) {
                    props.onSendChat();
                  }
                }
              }}
            ></textarea>
            <button class="btn btn--sm" ?disabled=${!canSendCommand} @click=${props.onSendChat}>
              ${props.chatSending ? "Sending..." : "Send mission command"}
            </button>
          </div>
          <div class="mission-note">Runs in current chat session. Shift+Enter for new line.</div>
        </section>

        <section class="mission-agents card">
          <div class="mission-section-title">Agent Deck</div>
          <div class="mission-chip-grid">
            ${
              agents.length > 0
                ? agents.slice(0, 12).map((agent) => renderAgentChip(agent, defaultAgentId))
                : html`<div class="muted">No agents reported.</div>`
            }
          </div>
        </section>
      </div>
    </section>
  `;
}
