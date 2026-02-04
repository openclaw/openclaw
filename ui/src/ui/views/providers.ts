import { html, nothing } from "lit";
import type { ProviderHealthEntry, UsageWindowEntry } from "../controllers/providers-health.ts";

export type ProvidersProps = {
  loading: boolean;
  error: string | null;
  entries: ProviderHealthEntry[];
  updatedAt: number | null;
  showAll: boolean;
  expandedId: string | null;
  instanceCount: number;
  sessionCount: number | null;
  agentRunning: boolean;
  onRefresh: () => void;
  onToggleShowAll: () => void;
  onToggleExpand: (id: string) => void;
};

export function renderProviders(props: ProvidersProps) {
  const detectedCount = props.entries.filter((e) => e.detected).length;
  const totalCount = props.entries.length;

  return html`
    <section class="grid grid-cols-3" style="margin-bottom: 18px;">
      <div class="card stat-card">
        <div class="stat-label">Instances</div>
        <div class="stat-value">${props.instanceCount}</div>
        <div class="muted">Active presence beacons.</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${props.sessionCount ?? "n/a"}</div>
        <div class="muted">Tracked session keys.</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Agent</div>
        <div class="stat-value ${props.agentRunning ? "ok" : ""}">${props.agentRunning ? "Running" : "Idle"}</div>
        <div class="muted">${props.agentRunning ? "An agent run is in progress." : "No active agent run."}</div>
      </div>
    </section>

    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Provider Health</div>
          <div class="card-sub">
            ${detectedCount} detected${props.showAll ? ` / ${totalCount} total` : ""}
            ${props.updatedAt ? html` &mdash; updated ${formatTimeAgo(props.updatedAt)}` : nothing}
          </div>
        </div>
        <div class="row" style="gap: 8px;">
          <label class="row" style="gap: 4px; cursor: pointer; font-size: 13px;">
            <input
              type="checkbox"
              ?checked=${props.showAll}
              @change=${props.onToggleShowAll}
            />
            Show all
          </label>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px;">
        ${
          props.entries.length === 0
            ? html`
                <div class="muted">No providers found.</div>
              `
            : props.entries.map((entry) =>
                renderProviderCard(entry, props.expandedId === entry.id, () =>
                  props.onToggleExpand(entry.id),
                ),
              )
        }
      </div>
    </section>
  `;
}

function renderProviderCard(entry: ProviderHealthEntry, expanded: boolean, onToggle: () => void) {
  const color = getHealthColor(entry.healthStatus);
  const label = getHealthLabel(entry.healthStatus);
  const dotStyle = `width: 8px; height: 8px; border-radius: 50%; background: ${color}; flex-shrink: 0;`;

  return html`
    <div
      class="list-item"
      style="border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; cursor: pointer;"
      @click=${onToggle}
    >
      <div style="display: flex; align-items: center; gap: 12px; width: 100%;">
        <div style="${dotStyle}"></div>
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-weight: 600;">${entry.name}</span>
            ${
              entry.authMode && entry.authMode !== "unknown"
                ? html`<span class="chip">${entry.authMode}</span>`
                : nothing
            }
            ${
              entry.isLocal
                ? html`
                    <span class="chip">local</span>
                  `
                : nothing
            }
          </div>
          ${renderQuickStatus(entry)}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span
            class="chip"
            style="background: ${color}20; color: ${color}; border-color: ${color}40;"
          >
            ${label}
          </span>
          <span style="font-size: 12px; opacity: 0.5;">${expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      ${
        expanded
          ? html`
            <div
              style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); width: 100%;"
              @click=${(e: Event) => e.stopPropagation()}
            >
              ${renderCredentialInfo(entry)} ${renderUsageSection(entry)}
            </div>
          `
          : nothing
      }
    </div>
  `;
}

function renderQuickStatus(entry: ProviderHealthEntry) {
  if (!entry.detected) {
    return html`
      <div class="muted" style="font-size: 12px">Not configured</div>
    `;
  }

  const parts: unknown[] = [];

  if (entry.inCooldown && entry.cooldownRemainingMs > 0) {
    parts.push(
      html`<span style="color: var(--danger); font-size: 12px;">
        Cooldown: ${formatCountdown(entry.cooldownRemainingMs)}
      </span>`,
    );
  }

  if (
    entry.tokenValidity === "expiring" &&
    entry.tokenRemainingMs !== null &&
    entry.tokenRemainingMs > 0
  ) {
    parts.push(
      html`<span style="color: var(--warning); font-size: 12px;">
        Token expires: ${formatCountdown(entry.tokenRemainingMs)}
      </span>`,
    );
  }

  if (entry.lastUsed) {
    parts.push(
      html`<span class="muted" style="font-size: 12px;">
        Last used: ${formatTimeAgo(new Date(entry.lastUsed).getTime())}
      </span>`,
    );
  }

  if (parts.length === 0) {
    return nothing;
  }

  return html`<div
    style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 2px;"
  >
    ${parts}
  </div>`;
}

function renderCredentialInfo(entry: ProviderHealthEntry) {
  if (!entry.detected) {
    return html`
      <div class="muted" style="font-size: 13px">
        Provider not detected. Configure credentials to enable.
      </div>
    `;
  }

  return html`
    <div style="margin-bottom: 12px;">
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Credentials</div>
      <div style="display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 13px;">
        <span class="muted">Source</span>
        <span>${entry.authSource ?? "unknown"}</span>

        <span class="muted">Mode</span>
        <span>${entry.authMode}</span>

        <span class="muted">Token</span>
        <span>
          ${
            entry.tokenValidity === "valid"
              ? "Valid"
              : entry.tokenValidity === "expiring"
                ? html`Expiring
                  ${
                    entry.tokenRemainingMs !== null
                      ? html` (${formatCountdown(entry.tokenRemainingMs)})`
                      : nothing
                  }`
                : entry.tokenValidity === "expired"
                  ? html`
                      <span style="color: var(--danger)">Expired</span>
                    `
                  : "No expiration"
          }
        </span>

        <span class="muted">Errors</span>
        <span>${entry.errorCount}</span>

        ${
          entry.inCooldown
            ? html`
              <span class="muted">Cooldown</span>
              <span style="color: var(--danger);">
                ${formatCountdown(entry.cooldownRemainingMs)}
              </span>
            `
            : nothing
        }
        ${
          entry.disabledReason
            ? html`
              <span class="muted">Disabled</span>
              <span style="color: var(--danger);">${entry.disabledReason}</span>
            `
            : nothing
        }
      </div>
    </div>
  `;
}

function renderUsageSection(entry: ProviderHealthEntry) {
  if (entry.usageError) {
    return html`
      <div>
        <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Usage Quota</div>
        <div class="muted" style="font-size: 12px;">${entry.usageError}</div>
      </div>
    `;
  }

  if (!entry.usageWindows || entry.usageWindows.length === 0) {
    if (entry.usagePlan) {
      return html`
        <div>
          <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Usage Quota</div>
          <div class="muted" style="font-size: 12px;">Plan: ${entry.usagePlan}</div>
        </div>
      `;
    }
    return nothing;
  }

  return html`
    <div>
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">
        Usage Quota
        ${entry.usagePlan ? html`<span class="muted" style="font-weight: 400;"> (${entry.usagePlan})</span>` : nothing}
      </div>
      ${entry.usageWindows.map((w) => renderUsageBar(w))}
    </div>
  `;
}

function renderUsageBar(window: UsageWindowEntry) {
  const pct = Math.min(100, Math.max(0, window.usedPercent));
  const barColor =
    pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warning)" : "var(--ok, #22c55e)";

  return html`
    <div style="margin-bottom: 8px;">
      <div
        style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; margin-bottom: 3px;"
      >
        <span>${window.label}</span>
        <span>
          ${pct.toFixed(1)}%
          ${
            window.resetRemainingMs !== null && window.resetRemainingMs > 0
              ? html`<span class="muted"> &middot; Resets: ${formatCountdown(window.resetRemainingMs)}</span>`
              : nothing
          }
        </span>
      </div>
      <div
        style="height: 6px; background: var(--border); border-radius: 3px; overflow: hidden;"
      >
        <div
          style="height: 100%; width: ${pct}%; background: ${barColor}; border-radius: 3px; transition: width 1s linear;"
        ></div>
      </div>
    </div>
  `;
}

// --- Helpers ---

function getHealthColor(status: string): string {
  switch (status) {
    case "healthy":
      return "var(--ok, #22c55e)";
    case "warning":
      return "var(--warning, #eab308)";
    case "cooldown":
    case "expired":
    case "disabled":
      return "var(--danger, #ef4444)";
    case "missing":
      return "var(--muted-fg, #888)";
    default:
      return "var(--muted-fg, #888)";
  }
}

function getHealthLabel(status: string): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "cooldown":
      return "Cooldown";
    case "expired":
      return "Expired";
    case "disabled":
      return "Disabled";
    case "missing":
      return "Not detected";
    default:
      return status;
  }
}

function formatCountdown(ms: number): string {
  if (ms <= 0) {
    return "0s";
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatTimeAgo(timestampMs: number): string {
  const diff = Date.now() - timestampMs;
  if (diff < 0) {
    return "just now";
  }
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
