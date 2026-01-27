import { html, nothing } from "lit";
import { toast } from "../components/toast";

import { formatEventPayload } from "../presenter";
import { icon } from "../icons";
import type { EventLogEntry } from "../app-events";

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

type DebugTab = "status" | "health" | "models" | "rpc";

// Track active tab in module scope for simplicity
let activeTab: DebugTab = "status";

function setActiveTab(tab: DebugTab) {
  activeTab = tab;
}

/**
 * Format JSON with syntax highlighting
 */
function formatJsonHighlighted(data: unknown): ReturnType<typeof html> {
  if (data === null || data === undefined) {
    return html`<span class="json-viewer__null">null</span>`;
  }

  try {
    const jsonStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    // Parse and re-stringify to ensure valid JSON
    const parsed = JSON.parse(jsonStr);
    const highlighted = highlightJson(parsed, 0);
    return html`<pre class="json-viewer">${highlighted}</pre>`;
  } catch {
    return html`<pre class="json-viewer">${String(data)}</pre>`;
  }
}

function highlightJson(value: unknown, indent: number): ReturnType<typeof html>[] {
  const spaces = "  ".repeat(indent);
  const results: ReturnType<typeof html>[] = [];

  if (value === null) {
    results.push(html`<span class="json-viewer__null">null</span>`);
  } else if (typeof value === "boolean") {
    results.push(html`<span class="json-viewer__boolean">${String(value)}</span>`);
  } else if (typeof value === "number") {
    results.push(html`<span class="json-viewer__number">${value}</span>`);
  } else if (typeof value === "string") {
    results.push(html`<span class="json-viewer__string">"${value}"</span>`);
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      results.push(html`<span class="json-viewer__bracket">[]</span>`);
    } else {
      results.push(html`<span class="json-viewer__bracket">[</span>\n`);
      value.forEach((item, i) => {
        results.push(html`${spaces}  `);
        results.push(...highlightJson(item, indent + 1));
        if (i < value.length - 1) results.push(html`,`);
        results.push(html`\n`);
      });
      results.push(html`${spaces}<span class="json-viewer__bracket">]</span>`);
    }
  } else if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      results.push(html`<span class="json-viewer__bracket">{}</span>`);
    } else {
      results.push(html`<span class="json-viewer__bracket">{</span>\n`);
      entries.forEach(([key, val], i) => {
        results.push(html`${spaces}  <span class="json-viewer__key">"${key}"</span>: `);
        results.push(...highlightJson(val, indent + 1));
        if (i < entries.length - 1) results.push(html`,`);
        results.push(html`\n`);
      });
      results.push(html`${spaces}<span class="json-viewer__bracket">}</span>`);
    }
  }

  return results;
}

function renderStatusTab(props: DebugProps) {
  const status = props.status ?? {};
  const health = props.health ?? {};
  const heartbeat = props.heartbeat as Record<string, unknown> | null;

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
    critical > 0
      ? `${critical} critical`
      : warn > 0
        ? `${warn} warnings`
        : "No critical issues";

  // Extract key status values
  const connected = status.connected ?? false;
  const uptime = status.uptimeMs ? formatUptime(status.uptimeMs as number) : "Unknown";
  const heartbeatAge = heartbeat?.ts
    ? formatHeartbeatAge(heartbeat.ts as number)
    : "No heartbeat";

  // Extract health metrics
  const memoryMb = health.memoryMb ?? health.heapUsedMB ?? 0;
  const connections = health.connections ?? health.activeConnections ?? 0;
  const queueSize = health.queueSize ?? health.pendingTasks ?? 0;

  return html`
    <div class="debug-status-grid">
      <!-- System Status Cards -->
      <div class="debug-status__card ${connected ? "debug-status__ok" : "debug-status__error"}">
        <div class="debug-status__icon">
          ${connected ? icon("check", { size: 20 }) : icon("alert-circle", { size: 20 })}
        </div>
        <div class="debug-status__label">Gateway</div>
        <div class="debug-status__value">${connected ? "Connected" : "Disconnected"}</div>
      </div>

      <div class="debug-status__card debug-status__neutral">
        <div class="debug-status__icon">
          ${icon("clock", { size: 20 })}
        </div>
        <div class="debug-status__label">Uptime</div>
        <div class="debug-status__value">${uptime}</div>
      </div>

      <div class="debug-status__card ${heartbeat ? "debug-status__ok" : "debug-status__warn"}">
        <div class="debug-status__icon">
          ${icon("zap", { size: 20 })}
        </div>
        <div class="debug-status__label">Heartbeat</div>
        <div class="debug-status__value">${heartbeatAge}</div>
      </div>

      <div class="debug-status__card debug-status__neutral">
        <div class="debug-status__icon">
          ${icon("brain", { size: 20 })}
        </div>
        <div class="debug-status__label">Memory</div>
        <div class="debug-status__value">${Number(memoryMb).toFixed(1)} MB</div>
      </div>

      <div class="debug-status__card debug-status__neutral">
        <div class="debug-status__icon">
          ${icon("link", { size: 20 })}
        </div>
        <div class="debug-status__label">Connections</div>
        <div class="debug-status__value">${connections} active</div>
      </div>

      <div class="debug-status__card ${Number(queueSize) > 0 ? "debug-status__warn" : "debug-status__neutral"}">
        <div class="debug-status__icon">
          ${icon("server", { size: 20 })}
        </div>
      <div class="debug-status__label">Queue</div>
      <div class="debug-status__value">${queueSize} pending</div>
      </div>
    </div>

    ${securitySummary
      ? html`<div class="callout ${securityTone}" style="margin: 12px 0;">
          Security audit: ${securityLabel}${info > 0 ? ` · ${info} info` : ""}. Run
          <span class="mono">clawdbot security audit --deep</span> for details.
        </div>`
      : nothing}

    <!-- Raw Data Section -->
    <div class="debug-raw-section">
      <details class="debug-raw-details">
        <summary class="debug-raw-summary">
          ${icon("chevron-right", { size: 14 })}
          <span>Raw Status Data</span>
        </summary>
        <div class="debug-raw-content">
          ${formatJsonHighlighted(props.status)}
        </div>
      </details>

      <details class="debug-raw-details">
        <summary class="debug-raw-summary">
          ${icon("chevron-right", { size: 14 })}
          <span>Raw Heartbeat Data</span>
        </summary>
        <div class="debug-raw-content">
          ${formatJsonHighlighted(props.heartbeat)}
        </div>
      </details>
    </div>
  `;
}

function renderHealthTab(props: DebugProps) {
  const health = props.health ?? {};

  return html`
    <div class="health-overview">
      <div class="health-header">
        <div class="health-header__title">System Health Metrics</div>
        <div class="health-header__sub">Real-time gateway health information</div>
      </div>

      ${formatJsonHighlighted(health)}
    </div>
  `;
}

function renderModelsTab(props: DebugProps) {
  const models = props.models ?? [];

  if (!Array.isArray(models) || models.length === 0) {
    return html`
      <div class="models-empty">
        <div class="models-empty__icon">${icon("brain", { size: 32 })}</div>
        <div class="models-empty__text">No models available</div>
        <div class="models-empty__sub">Configure an AI provider in your gateway settings to see available models</div>
      </div>
    `;
  }

  return html`
    <div class="models-list">
      ${models.map((model: unknown) => {
        const m = model as Record<string, unknown>;
        const name = m.name ?? m.id ?? "Unknown";
        const provider = m.provider ?? m.source ?? "Unknown";
        const available = m.available !== false;

        return html`
          <div class="model-card ${available ? "model-card--available" : "model-card--unavailable"}">
            <div class="model-card__header">
              <div class="model-card__icon">
                ${icon("sparkles", { size: 18 })}
              </div>
              <div class="model-card__info">
                <div class="model-card__name">${name}</div>
                <div class="model-card__provider">${provider}</div>
              </div>
            </div>
            <div class="model-card__status">
              <span class="model-card__dot ${available ? "model-card__dot--ok" : "model-card__dot--error"}"></span>
              <span>${available ? "Available" : "Unavailable"}</span>
            </div>
          </div>
        `;
      })}
    </div>

    <details class="debug-raw-details" style="margin-top: 16px;">
      <summary class="debug-raw-summary">
        ${icon("chevron-right", { size: 14 })}
        <span>Raw Models Data</span>
      </summary>
      <div class="debug-raw-content">
        ${formatJsonHighlighted(models)}
      </div>
    </details>
  `;
}

function renderRpcTab(props: DebugProps) {
  const copyToClipboard = () => {
    if (props.callResult) {
      navigator.clipboard.writeText(props.callResult).then(() => {
        toast.success("Response copied");
      });
    }
  };

  return html`
    <div class="rpc-console rpc-console--modern">
      <div class="rpc-console__input">
        <div class="rpc-pane-header">
          <span class="rpc-pane-header__icon">${icon("send", { size: 14 })}</span>
          <span class="rpc-pane-header__title">Request</span>
        </div>
        <div class="rpc-method">
          <label class="rpc-method__label">
            ${icon("chevron-right", { size: 14 })}
            <span>Method</span>
          </label>
          <input
            class="rpc-method__input"
            .value=${props.callMethod}
            @input=${(e: Event) => props.onCallMethodChange((e.target as HTMLInputElement).value)}
            placeholder="sessions.list"
          />
        </div>

        <div class="rpc-params">
          <label class="rpc-params__label">
            ${icon("file-text", { size: 14 })}
            <span>Parameters (JSON)</span>
          </label>
          <textarea
            class="rpc-params__editor"
            .value=${props.callParams}
            @input=${(e: Event) => props.onCallParamsChange((e.target as HTMLTextAreaElement).value)}
            placeholder='{ "limit": 10 }'
            rows="8"
          ></textarea>
        </div>

        <button class="rpc-execute btn btn--primary" @click=${props.onCall}>
          ${icon("play", { size: 16 })}
          <span>Execute</span>
        </button>
      </div>

      <div class="rpc-console__output">
        <div class="rpc-response__header">
          <div class="rpc-pane-header">
            <span class="rpc-pane-header__icon">${icon("check", { size: 14 })}</span>
            <span class="rpc-pane-header__title">Response</span>
          </div>
          <div class="rpc-response__actions">
            ${props.callResult
              ? html`
                  <button class="btn btn--sm" @click=${copyToClipboard} title="Copy to clipboard">
                    ${icon("copy", { size: 14 })}
                  </button>
                `
              : nothing}
          </div>
        </div>

        <div class="rpc-response__body">
          ${props.callError
            ? html`
                <div class="rpc-response__error">
                  <div class="rpc-response__error-icon">${icon("alert-circle", { size: 18 })}</div>
                  <div class="rpc-response__error-text">${props.callError}</div>
                </div>
              `
            : props.callResult
              ? formatJsonHighlighted(props.callResult)
              : html`<div class="rpc-response__empty">
                  <div class="rpc-response__empty-icon">${icon("zap", { size: 24 })}</div>
                  <div>Execute a method to see the response</div>
                </div>`}
        </div>
      </div>
    </div>
  `;
}

function renderEventLog(props: DebugProps) {
  if (props.eventLog.length === 0) {
    return html`
      <div class="event-log__empty">
        <div class="event-log__empty-icon">${icon("scroll-text", { size: 24 })}</div>
        <div class="event-log__empty-text">No events yet</div>
      </div>
    `;
  }

  return html`
    <div class="event-log">
      ${props.eventLog.map(
        (evt) => html`
          <div class="event-log__entry">
            <div class="event-log__time">${new Date(evt.ts).toLocaleTimeString()}</div>
            <div class="event-log__type">${evt.event}</div>
            <div class="event-log__data">
              <pre>${formatEventPayload(evt.payload)}</pre>
            </div>
          </div>
        `
      )}
    </div>
  `;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatHeartbeatAge(ts: number): string {
  const age = Date.now() - ts;
  const seconds = Math.floor(age / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export function renderDebug(props: DebugProps) {
  const handleTabClick = (tab: DebugTab) => () => {
    setActiveTab(tab);
    // Force re-render by triggering a state update
    // The parent component handles this through its own state management
  };

  return html`
    <div class="debug-container debug-container--modern">
      <!-- Header -->
      <div class="debug-header debug-header--modern">
        <div class="debug-header__left">
          <div class="debug-header__icon">
            ${icon("bug", { size: 24 })}
          </div>
          <div class="debug-header__text">
            <div class="debug-header__title">Debug Console</div>
            <div class="debug-header__sub">System diagnostics and RPC interface</div>
          </div>
        </div>
        <button class="btn btn--secondary" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${icon("refresh-cw", { size: 16, class: props.loading ? "spin" : "" })}
          <span>${props.loading ? "Refreshing..." : "Refresh"}</span>
        </button>
      </div>

      <!-- Tabs -->
      <div class="debug-tabs debug-tabs--modern">
        <button
          class="debug-tab ${activeTab === "status" ? "debug-tab--active" : ""}"
          @click=${handleTabClick("status")}
        >
          ${icon("server", { size: 16 })}
          <span>Status</span>
        </button>
        <button
          class="debug-tab ${activeTab === "health" ? "debug-tab--active" : ""}"
          @click=${handleTabClick("health")}
        >
          ${icon("zap", { size: 16 })}
          <span>Health</span>
        </button>
        <button
          class="debug-tab ${activeTab === "models" ? "debug-tab--active" : ""}"
          @click=${handleTabClick("models")}
        >
          ${icon("brain", { size: 16 })}
          <span>Models</span>
        </button>
        <button
          class="debug-tab ${activeTab === "rpc" ? "debug-tab--active" : ""}"
          @click=${handleTabClick("rpc")}
        >
          ${icon("send", { size: 16 })}
          <span>RPC Console</span>
        </button>
      </div>

      <!-- Tab Content -->
      <div class="debug-content">
        ${activeTab === "status" ? renderStatusTab(props) : nothing}
        ${activeTab === "health" ? renderHealthTab(props) : nothing}
        ${activeTab === "models" ? renderModelsTab(props) : nothing}
        ${activeTab === "rpc" ? renderRpcTab(props) : nothing}
      </div>

      <!-- Event Log Section -->
      <div class="debug-event-section debug-event-section--modern">
        <div class="debug-section-header">
          <div class="debug-section-icon">${icon("scroll-text", { size: 18 })}</div>
          <div class="debug-section-title">Event Log</div>
          <div class="debug-section-sub">Recent gateway events</div>
        </div>
        ${renderEventLog(props)}
      </div>
    </div>
  `;
}
