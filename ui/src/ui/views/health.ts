import { html, nothing } from "lit";
import type { HealthData, SystemResourceMetrics } from "../controllers/health.ts";
import { renderSpinner } from "../render-utils.ts";

export type HealthProps = {
  loading: boolean;
  error: string | null;
  data: HealthData | null;
  channels: Array<{ id: string; status: string }>;
  connected: boolean;
  debugHealth: unknown;
  onRefresh: () => void;
};

function channelStatusColor(status: string): string {
  switch (status) {
    case "connected":
    case "healthy":
    case "ok":
      return "var(--ok)";
    case "degraded":
    case "warning":
      return "var(--warn)";
    case "disconnected":
    case "error":
    case "down":
      return "var(--danger)";
    default:
      return "var(--muted)";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatHeartbeatAge(ms: number | null): string {
  if (ms === null) {
    return "n/a";
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(0)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/** Interpolate green (#22c55e) → yellow (#eab308) → red (#ef4444) based on %. */
function usageGradientColor(pct: number): string {
  const c = Math.max(0, Math.min(100, pct));
  let r: number, g: number, b: number;
  if (c <= 50) {
    const t = c / 50;
    r = Math.round(0x22 + (0xea - 0x22) * t);
    g = Math.round(0xc5 + (0xb3 - 0xc5) * t);
    b = Math.round(0x5e + (0x08 - 0x5e) * t);
  } else {
    const t = (c - 50) / 50;
    r = Math.round(0xea + (0xef - 0xea) * t);
    g = Math.round(0xb3 + (0x44 - 0xb3) * t);
    b = Math.round(0x08 + (0x44 - 0x08) * t);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

function renderResourceBar(label: string, pct: number, detail: string) {
  const color = usageGradientColor(pct);
  return html`
    <div style="margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; margin-bottom: 4px;">
        <span style="font-weight: 500;">${label}</span>
        <span class="muted">${pct.toFixed(1)}% · ${detail}</span>
      </div>
      <div class="usage-bar">
        <div class="usage-bar__fill" style="width: ${pct.toFixed(1)}%; background: ${color};"></div>
      </div>
    </div>
  `;
}

function renderSystemResources(sys: SystemResourceMetrics) {
  const memPct = sys.memory.usedPercent;
  const memDetail = `${formatBytes(sys.memory.usedBytes)} / ${formatBytes(sys.memory.totalBytes)}`;

  const heapPct =
    sys.memory.process.heapTotalBytes > 0
      ? (sys.memory.process.heapUsedBytes / sys.memory.process.heapTotalBytes) * 100
      : 0;
  const heapDetail = `${formatBytes(sys.memory.process.heapUsedBytes)} / ${formatBytes(sys.memory.process.heapTotalBytes)}`;

  // Normalize load avg to percentage of cores
  const loadPct = sys.cpu.cores > 0 ? (sys.cpu.loadAvg[0] / sys.cpu.cores) * 100 : 0;
  const loadDetail = `${sys.cpu.loadAvg[0].toFixed(2)} / ${sys.cpu.cores} cores`;

  return html`
    <section class="card" style="margin-top: 18px;">
      <div class="card-title">System Resources</div>
      <div class="card-sub">Machine and process resource utilization.</div>

      <div class="grid" style="margin-top: 16px; margin-bottom: 16px; grid-template-columns: repeat(4, minmax(0, 1fr));">
        <div class="card stat-card">
          <div class="stat-label">Hostname</div>
          <div class="stat-value" style="font-size: 16px; word-break: break-all;">${sys.platform.hostname}</div>
          <div class="muted">${sys.platform.os}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Architecture</div>
          <div class="stat-value" style="font-size: 16px;">${sys.platform.arch}</div>
          <div class="muted">${sys.cpu.cores} cores</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">System Uptime</div>
          <div class="stat-value" style="font-size: 16px;">${formatUptime(sys.uptime.systemSeconds)}</div>
          <div class="muted">Node ${sys.platform.nodeVersion}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Process Uptime</div>
          <div class="stat-value" style="font-size: 16px;">${formatUptime(sys.uptime.processSeconds)}</div>
          <div class="muted">RSS: ${formatBytes(sys.memory.process.rssBytes)}</div>
        </div>
      </div>

      <div style="padding: 0 4px;">
        ${renderResourceBar("CPU Load (1m avg)", loadPct, loadDetail)}
        ${renderResourceBar("System Memory", memPct, memDetail)}
        ${renderResourceBar("Process Heap", heapPct, heapDetail)}
        ${sys.disk ? renderResourceBar("Disk Usage", sys.disk.usedPercent, `${formatBytes(sys.disk.usedBytes)} / ${formatBytes(sys.disk.totalBytes)}`) : nothing}
      </div>

      <div style="margin-top: 8px; font-size: 11px; opacity: 0.6; padding: 0 4px;">
        CPU: ${sys.cpu.model} · Load avg: ${sys.cpu.loadAvg[0].toFixed(2)}, ${sys.cpu.loadAvg[1].toFixed(2)}, ${sys.cpu.loadAvg[2].toFixed(2)}
      </div>
    </section>
  `;
}

export function renderHealth(props: HealthProps) {
  const data = props.data;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">System Health</div>
          <div class="card-sub">Gateway health snapshot and channel status.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      ${props.error ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>` : nothing}

      ${
        props.loading && !data
          ? renderSpinner("Loading health data...")
          : html`
            <div class="grid grid-cols-3" style="margin-top: 16px;">
              <div class="card stat-card">
                <div class="stat-label">Gateway</div>
                <div class="stat-value ${props.connected ? "ok" : ""}">
                  ${props.connected ? "Online" : "Offline"}
                </div>
                ${data ? html`<div class="muted">Probe: ${formatDuration(data.durationMs)}</div>` : nothing}
              </div>
              <div class="card stat-card">
                <div class="stat-label">Sessions</div>
                <div class="stat-value">${data?.sessionCount ?? 0}</div>
                ${data?.sessionPath ? html`<div class="muted" style="word-break: break-all; font-size: 11px;">${data.sessionPath}</div>` : nothing}
              </div>
              <div class="card stat-card">
                <div class="stat-label">Channels</div>
                <div class="stat-value">${data?.channels.length ?? 0}</div>
                <div class="muted">
                  ${data ? `${data.channels.filter((c) => c.linked).length} linked` : ""}
                </div>
              </div>
            </div>
          `
      }
    </section>

    ${data?.system ? renderSystemResources(data.system) : nothing}

    ${
      data && data.agents.length > 0
        ? html`
          <section class="card" style="margin-top: 18px;">
            <div class="card-title">Agents</div>
            <div class="card-sub">Heartbeat and session status per agent.</div>
            <div class="list" style="margin-top: 12px;">
              ${data.agents.map(
                (agent) => html`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">
                        ${agent.name ?? agent.agentId}
                        ${
                          agent.isDefault
                            ? html`
                                <span class="chip chip-ok" style="margin-left: 6px">default</span>
                              `
                            : nothing
                        }
                      </div>
                      <div class="list-sub">${agent.agentId}</div>
                    </div>
                    <div class="list-meta" style="text-align: right;">
                      <div>
                        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${agent.heartbeatAlive ? "var(--ok)" : "var(--danger)"}; margin-right: 4px;"></span>
                        ${agent.heartbeatAlive ? "Alive" : "Dead"}
                      </div>
                      <div class="muted">${formatHeartbeatAge(agent.heartbeatAgeMs)}</div>
                      <div class="muted">${agent.sessionCount} sessions</div>
                    </div>
                  </div>
                `,
              )}
            </div>
          </section>
        `
        : nothing
    }

    ${
      props.channels.length > 0
        ? html`
          <section class="card" style="margin-top: 18px;">
            <div class="card-title">Channel Health</div>
            <div class="card-sub">Status of all registered channels.</div>
            <div class="health-channel-matrix" style="margin-top: 12px;">
              ${props.channels.map(
                (ch) => html`
                  <div class="health-channel-cell">
                    <div style="width: 8px; height: 8px; border-radius: 50%; background: ${channelStatusColor(ch.status)}; flex-shrink: 0;"></div>
                    <span>${ch.id}</span>
                    <span class="muted" style="font-size: 11px;">${ch.status}</span>
                  </div>
                `,
              )}
            </div>
          </section>
        `
        : nothing
    }
  `;
}
