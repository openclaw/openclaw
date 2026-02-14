import { html, nothing } from "lit";
import type { EventLogEntry } from "../app-events.ts";
import { formatEventPayload } from "../presenter.ts";
import { renderJsonBlock } from "./json-renderer.ts";
import { icons } from "../icons.ts";

export type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  heartbeat: unknown;
  eventLog: EventLogEntry[];
  callMethod: string;
  callParams: string;
  callResult: string | null;
  callError: string | null;
  onCallMethodChange: (next: string) => void;
  onCallParamsChange: (next: string) => void;
  onRefresh: () => void;
  onCall: () => void;
};

type SnapshotEntry = {
  name: string;
  icon: unknown;
  keyCount: number;
  data: unknown;
};

let selectedSnapshot: string | null = null;
let selectedEventIndex: number | null = null;
let showMethodSuggestions = false;

type RpcMethod = { method: string; params: string; description: string };

const RPC_METHODS: RpcMethod[] = [
  { method: "status", params: "{}", description: "Gateway status snapshot" },
  { method: "health", params: "{}", description: "Health check" },
  { method: "last-heartbeat", params: "{}", description: "Last heartbeat data" },
  { method: "system-presence", params: "{}", description: "System presence info" },
  { method: "models.list", params: "{}", description: "List available models" },
  { method: "logs.tail", params: '{"lines": 100}', description: "Tail log entries" },
  { method: "config.set", params: '{"path": "key", "value": "val"}', description: "Set a config value" },
  { method: "config.apply", params: '{"config": {}}', description: "Apply full config" },
  { method: "chat.send", params: '{"message": "", "to": ""}', description: "Send a chat message" },
  { method: "sessions.usage", params: '{"sessionKey": ""}', description: "Session usage stats" },
  { method: "sessions.usage.logs", params: '{"sessionKey": ""}', description: "Session usage logs" },
  { method: "sessions.usage.timeseries", params: '{"sessionKey": ""}', description: "Usage time series" },
  { method: "sessions.delete", params: '{"sessionKey": ""}', description: "Delete a session" },
  { method: "sessions.patch", params: '{"sessionKey": "", "patch": {}}', description: "Patch session data" },
  { method: "usage.cost", params: "{}", description: "Usage cost summary" },
  { method: "skills.status", params: "{}", description: "Installed skills status" },
  { method: "skills.update", params: '{"name": ""}', description: "Update a skill" },
  { method: "cron.add", params: '{"name": "", "schedule": {}, "payload": {}}', description: "Add a cron job" },
  { method: "cron.run", params: '{"jobId": ""}', description: "Trigger a cron job" },
  { method: "cron.update", params: '{"jobId": "", "patch": {}}', description: "Update a cron job" },
  { method: "cron.remove", params: '{"jobId": ""}', description: "Remove a cron job" },
  { method: "agent.identity.get", params: "{}", description: "Get agent identity" },
  { method: "channels.logout", params: '{"channel": ""}', description: "Logout a channel" },
  { method: "device.pair.approve", params: '{"requestId": ""}', description: "Approve device pairing" },
  { method: "device.pair.reject", params: '{"requestId": ""}', description: "Reject device pairing" },
  { method: "device.token.revoke", params: '{"deviceId": ""}', description: "Revoke device token" },
  { method: "exec.approval.resolve", params: '{"id": "", "approved": true}', description: "Resolve exec approval" },
  { method: "update.run", params: "{}", description: "Run gateway update" },
];

function countKeys(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  if (Array.isArray(data)) return data.length;
  return Object.keys(data).length;
}

function buildSnapshots(props: DebugProps): SnapshotEntry[] {
  return [
    { name: "Status", icon: icons.barChart, keyCount: countKeys(props.status), data: props.status ?? {} },
    { name: "Health", icon: icons.zap, keyCount: countKeys(props.health), data: props.health ?? {} },
    { name: "Heartbeat", icon: icons.radio, keyCount: countKeys(props.heartbeat), data: props.heartbeat ?? {} },
    { name: "Models", icon: icons.brain, keyCount: Array.isArray(props.models) ? props.models.length : 0, data: props.models ?? [] },
  ];
}

export function renderDebug(props: DebugProps) {
  const securityAudit =
    props.status && typeof props.status === "object"
      ? (props.status as { securityAudit?: { summary?: Record<string, number> } }).securityAudit
      : null;
  const securitySummary = securityAudit?.summary ?? null;
  const critical = securitySummary?.critical ?? 0;
  const warn = securitySummary?.warn ?? 0;
  const info = securitySummary?.info ?? 0;
  const securityTone = critical > 0 ? "danger" : warn > 0 ? "warn" : "success";
  const securityLabel =
    critical > 0 ? `${critical} critical` : warn > 0 ? `${warn} warnings` : "No critical issues";

  const snapshots = buildSnapshots(props);
  const activeSnapshot = snapshots.find((s) => s.name === selectedSnapshot) ?? null;

  // Trigger re-render hack via callback
  const requestUpdate = () => props.onCallMethodChange(props.callMethod);

  return html`
    ${
      securitySummary
        ? html`<div class="callout ${securityTone}" style="margin-bottom: 12px;">
          Security audit: ${securityLabel}${info > 0 ? ` · ${info} info` : ""}. Run
          <span class="mono">openclaw security audit --deep</span> for details.
        </div>`
        : nothing
    }

    <section class="card" style="margin-bottom: 12px;">
      <div class="row" style="gap: 12px; align-items: flex-end; flex-wrap: wrap;">
        <label class="field" style="flex: 1; min-width: 160px; margin: 0; position: relative;">
          <span>Method</span>
          <input
            .value=${props.callMethod}
            @input=${(e: Event) => {
              props.onCallMethodChange((e.target as HTMLInputElement).value);
              showMethodSuggestions = true;
            }}
            @focus=${() => { showMethodSuggestions = true; requestUpdate(); }}
            @blur=${() => { setTimeout(() => { showMethodSuggestions = false; requestUpdate(); }, 150); }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Tab" && showMethodSuggestions) {
                const needle = props.callMethod.toLowerCase();
                const match = RPC_METHODS.find((m) =>
                  !needle || m.method.toLowerCase().includes(needle) || m.description.toLowerCase().includes(needle)
                );
                if (match) {
                  e.preventDefault();
                  props.onCallMethodChange(match.method);
                  props.onCallParamsChange(match.params);
                  showMethodSuggestions = false;
                  requestUpdate();
                }
              }
            }}
            placeholder="system-presence"
            autocomplete="off"
          />
          ${showMethodSuggestions && props.callMethod.length >= 0 ? (() => {
            const needle = props.callMethod.toLowerCase();
            const matches = RPC_METHODS.filter((m) => 
              !needle || m.method.toLowerCase().includes(needle) || m.description.toLowerCase().includes(needle)
            ).slice(0, 10);
            return matches.length > 0 ? html`
              <div class="rpc-suggestions">
                ${matches.map((m) => html`
                  <div class="rpc-suggestion" @mousedown=${(e: Event) => {
                    e.preventDefault();
                    props.onCallMethodChange(m.method);
                    props.onCallParamsChange(m.params);
                    showMethodSuggestions = false;
                    requestUpdate();
                  }}>
                    <div class="rpc-suggestion-method mono">${m.method}</div>
                    <div class="rpc-suggestion-desc">${m.description}</div>
                  </div>
                `)}
              </div>
            ` : nothing;
          })() : nothing}
        </label>
        <label class="field" style="flex: 2; min-width: 200px; margin: 0;">
          <span>Params (JSON)</span>
          <input
            .value=${props.callParams}
            @input=${(e: Event) => props.onCallParamsChange((e.target as HTMLInputElement).value)}
            placeholder='{"key": "value"}'
          />
        </label>
        <button class="btn primary" @click=${props.onCall} style="height: 36px;">Call</button>
      </div>
      ${
        props.callError
          ? html`<div class="callout danger" style="margin-top: 8px;">${props.callError}</div>`
          : nothing
      }
      ${
        props.callResult
          ? html`<div style="margin-top: 8px;">${renderJsonBlock(props.callResult)}</div>`
          : nothing
      }
    </section>

    <section class="card" style="padding: 0;">
      <div class="row" style="justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div>
          <div class="card-title">Snapshots</div>
          <div class="card-sub">Status, health, heartbeat, and models.</div>
        </div>
        <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>
        <div class="logs-split ${activeSnapshot ? "logs-split--open" : ""}">
          <div style="flex: 1; min-width: 0;">
            <div class="debug-snapshot-header">
              <div class="debug-snapshot-cell" style="flex: 0 0 36px;"></div>
              <div class="debug-snapshot-cell" style="flex: 1;">Name</div>
              <div class="debug-snapshot-cell" style="flex: 0 0 80px; text-align: right;">Keys</div>
            </div>
            ${snapshots.map(
              (snap) => html`
                <div class="debug-snapshot-row ${selectedSnapshot === snap.name ? "selected" : ""}"
                  @click=${() => { selectedSnapshot = selectedSnapshot === snap.name ? null : snap.name; requestUpdate(); }}>
                  <div class="icon" style="flex: 0 0 36px; text-align: center; width: 16px; height: 16px;">${snap.icon}</div>
                  <div style="flex: 1; font-weight: 500;">${snap.name}</div>
                  <div class="mono" style="flex: 0 0 80px; text-align: right; color: var(--muted);">${snap.keyCount}</div>
                </div>
              `,
            )}
          </div>
          ${activeSnapshot ? html`
            <div class="log-detail" style="max-height: none;">
              <div class="log-detail-header">
                <div class="card-title" style="font-size: 13px; display: flex; align-items: center; gap: 6px;"><span class="icon" style="width: 14px; height: 14px;">${activeSnapshot.icon}</span>${activeSnapshot.name}</div>
                <button class="btn btn--sm" @click=${() => { selectedSnapshot = null; requestUpdate(); }}><span class="icon" style="width:12px;height:12px;">${icons.x}</span></button>
              </div>
              <div style="padding: 10px 14px;">
                ${renderJsonBlock(activeSnapshot.data)}
              </div>
            </div>
          ` : nothing}
        </div>
      </div>
    </section>

    <section class="card" style="margin-top: 12px; padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Event Log</div>
          <div class="card-sub">Latest gateway events.</div>
        </div>
      </div>
      ${
        props.eventLog.length === 0
          ? html`<div class="muted" style="padding: 12px 14px;">No events yet.</div>`
          : html`
            <div class="logs-split ${selectedEventIndex !== null ? "logs-split--open" : ""}">
              <div style="flex: 1; min-width: 0; overflow: hidden;">
                <div class="log-stream" style="max-height: 400px;">
                  <div class="log-header" style="grid-template-columns: 90px minmax(120px, 200px) minmax(0, 1fr);">
                    <div class="log-header-cell">Time</div>
                    <div class="log-header-cell">Event</div>
                    <div class="log-header-cell">Payload</div>
                  </div>
                  ${props.eventLog.map((evt, i) => html`
                    <div class="log-row ${selectedEventIndex === i ? "selected" : ""}"
                      style="grid-template-columns: 90px minmax(120px, 200px) minmax(0, 1fr);"
                      @click=${() => { selectedEventIndex = i; requestUpdate(); }}>
                      <div class="log-time mono">${new Date(evt.ts).toLocaleTimeString()}</div>
                      <div class="mono" style="font-weight: 500; font-size: 12px;">${evt.event}</div>
                      <div class="log-message mono">${formatEventPayload(evt.payload)}</div>
                    </div>
                  `)}
                </div>
              </div>
              ${selectedEventIndex !== null && props.eventLog[selectedEventIndex] ? html`
                <div class="log-detail" style="max-height: 400px;">
                  <div class="log-detail-header">
                    <div class="card-title" style="font-size: 13px;">${props.eventLog[selectedEventIndex].event}</div>
                    <button class="btn btn--sm" @click=${() => { selectedEventIndex = null; requestUpdate(); }}><span class="icon" style="width:12px;height:12px;">${icons.x}</span></button>
                  </div>
                  <div class="log-detail-fields">
                    <div class="log-detail-field">
                      <div class="log-detail-label">Time</div>
                      <div class="log-detail-value mono">${new Date(props.eventLog[selectedEventIndex].ts).toISOString()}</div>
                    </div>
                    <div class="log-detail-field">
                      <div class="log-detail-label">Event</div>
                      <div class="log-detail-value mono">${props.eventLog[selectedEventIndex].event}</div>
                    </div>
                    <div class="log-detail-field">
                      <div class="log-detail-label">Payload</div>
                      ${renderJsonBlock(props.eventLog[selectedEventIndex].payload)}
                    </div>
                  </div>
                </div>
              ` : nothing}
            </div>
          `
      }
    </section>
  `;
}
