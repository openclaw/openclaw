import { msg } from "@lit/localize";
import { html } from "lit";
import type { GatewayHelloOk } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";
import { formatAgo, formatDurationMs } from "../format.ts";
import { formatNextRun } from "../presenter.ts";

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
};

export function renderOverview(props: OverviewProps) {
  const snapshot = props.hello?.snapshot as
    | { uptimeMs?: number; policy?: { tickIntervalMs?: number } }
    | undefined;
  const uptime = snapshot?.uptimeMs
    ? formatDurationMs(snapshot.uptimeMs)
    : msg("n/a", { id: "overview.na" });
  const tick = snapshot?.policy?.tickIntervalMs
    ? `${snapshot.policy.tickIntervalMs}ms`
    : msg("n/a", { id: "overview.na" });
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
        <div class="muted" style="margin-top: 8px">
          ${msg("This gateway requires auth. Add a token or password, then click Connect.", {
            id: "overview.authRequired",
          })}
          <div style="margin-top: 6px">
            <span class="mono">openclaw dashboard --no-open</span> → ${msg("tokenized URL", { id: "overview.tokenizedUrl" })}<br />
            <span class="mono">openclaw doctor --generate-gateway-token</span> → ${msg("set token", { id: "overview.setToken" })}
          </div>
          <div style="margin-top: 6px">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target="_blank"
              rel="noreferrer"
              title=${msg("Control UI auth docs (opens in new tab)", {
                id: "overview.controlUiAuthDocsTitle",
              })}
              >${msg("Docs: Control UI auth", { id: "overview.controlUiAuthDocs" })}</a
            >
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${msg("Auth failed. Re-copy a tokenized URL with", { id: "overview.authFailedLead" })}
        <span class="mono">openclaw dashboard --no-open</span>, ${msg("or update the token, then click Connect.", { id: "overview.authFailedTail" })}
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/dashboard"
            target="_blank"
            rel="noreferrer"
            title=${msg("Control UI auth docs (opens in new tab)", {
              id: "overview.controlUiAuthDocsTitle",
            })}
            >${msg("Docs: Control UI auth", { id: "overview.controlUiAuthDocs" })}</a
          >
        </div>
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
      <div class="muted" style="margin-top: 8px">
        ${msg(
          "This page is HTTP, so the browser blocks device identity. Use HTTPS (Tailscale Serve) or open",
          { id: "overview.httpBlockedLead" },
        )}
        <span class="mono">http://127.0.0.1:18789</span> ${msg("on the gateway host.", {
          id: "overview.httpBlockedTail",
        })}
        <div style="margin-top: 6px">
          ${msg("If you must stay on HTTP, set", { id: "overview.httpStayLead" })}
          <span class="mono">gateway.controlUi.allowInsecureAuth: true</span> ${msg(
            "(token-only).",
            {
              id: "overview.httpStayTail",
            },
          )}
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/gateway/tailscale"
            target="_blank"
            rel="noreferrer"
            title=${msg("Tailscale Serve docs (opens in new tab)", { id: "overview.tailscaleDocsTitle" })}
            >${msg("Docs: Tailscale Serve", { id: "overview.tailscaleDocs" })}</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#insecure-http"
            target="_blank"
            rel="noreferrer"
            title=${msg("Insecure HTTP docs (opens in new tab)", { id: "overview.insecureHttpDocsTitle" })}
            >${msg("Docs: Insecure HTTP", { id: "overview.insecureHttpDocs" })}</a
          >
        </div>
      </div>
    `;
  })();

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">${msg("Gateway Access", { id: "overview.gatewayAccess" })}</div>
        <div class="card-sub">${msg("Where the dashboard connects and how it authenticates.", { id: "overview.gatewayAccessSub" })}</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>${msg("WebSocket URL", { id: "overview.wsUrl" })}</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: v });
              }}
              placeholder=${msg("ws://100.x.y.z:18789", { id: "overview.wsUrlPlaceholder" })}
            />
          </label>
          <label class="field">
            <span>${msg("Gateway Token", { id: "overview.gatewayToken" })}</span>
            <input
              .value=${props.settings.token}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, token: v });
              }}
              placeholder=${msg("OPENCLAW_GATEWAY_TOKEN", { id: "overview.gatewayTokenPlaceholder" })}
            />
          </label>
          <label class="field">
            <span>${msg("Password (not stored)", { id: "overview.password" })}</span>
            <input
              type="password"
              .value=${props.password}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onPasswordChange(v);
              }}
              placeholder=${msg("system or shared password", { id: "overview.passwordPlaceholder" })}
            />
          </label>
          <label class="field">
            <span>${msg("Default Session Key", { id: "overview.defaultSessionKey" })}</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSessionKeyChange(v);
              }}
            />
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>${msg("Connect", { id: "overview.connect" })}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${msg("Refresh", { id: "overview.refresh" })}</button>
          <span class="muted">${msg("Click Connect to apply connection changes.", { id: "overview.connectHint" })}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${msg("Snapshot", { id: "overview.snapshot" })}</div>
        <div class="card-sub">${msg("Latest gateway handshake information.", { id: "overview.snapshotSub" })}</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${msg("Status", { id: "overview.status" })}</div>
            <div class="stat-value ${props.connected ? "ok" : "warn"}">
              ${
                props.connected
                  ? msg("Connected", { id: "overview.connected" })
                  : msg("Disconnected", { id: "overview.disconnected" })
              }
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${msg("Uptime", { id: "overview.uptime" })}</div>
            <div class="stat-value">${uptime}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${msg("Tick Interval", { id: "overview.tickInterval" })}</div>
            <div class="stat-value">${tick}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${msg("Last Channels Refresh", { id: "overview.lastChannelsRefresh" })}</div>
            <div class="stat-value">
              ${props.lastChannelsRefresh ? formatAgo(props.lastChannelsRefresh) : msg("n/a", { id: "overview.na" })}
            </div>
          </div>
        </div>
        ${
          props.lastError
            ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${props.lastError}</div>
              ${authHint ?? ""}
              ${insecureContextHint ?? ""}
            </div>`
            : html`
                <div class="callout" style="margin-top: 14px">
                  ${msg("Use Channels to link WhatsApp, Telegram, Discord, Signal, or iMessage.", {
                    id: "overview.linkChannelsHint",
                  })}
                </div>
              `
        }
      </div>
    </section>

    <section class="grid grid-cols-3" style="margin-top: 18px;">
      <div class="card stat-card">
        <div class="stat-label">${msg("Instances", { id: "overview.instances" })}</div>
        <div class="stat-value">${props.presenceCount}</div>
        <div class="muted">${msg("Presence beacons in the last 5 minutes.", { id: "overview.instancesHint" })}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">${msg("Sessions", { id: "overview.sessions" })}</div>
        <div class="stat-value">${props.sessionsCount ?? msg("n/a", { id: "overview.na" })}</div>
        <div class="muted">${msg("Recent session keys tracked by the gateway.", { id: "overview.sessionsHint" })}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">${msg("Cron", { id: "overview.cron" })}</div>
        <div class="stat-value">
          ${
            props.cronEnabled == null
              ? msg("n/a", { id: "overview.na" })
              : props.cronEnabled
                ? msg("Enabled", { id: "overview.enabled" })
                : msg("Disabled", { id: "overview.disabled" })
          }
        </div>
        <div class="muted">${msg("Next wake", { id: "overview.nextWake" })} ${formatNextRun(props.cronNext)}</div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${msg("Notes", { id: "overview.notes" })}</div>
      <div class="card-sub">${msg("Quick reminders for remote control setups.", { id: "overview.notesSub" })}</div>
      <div class="note-grid" style="margin-top: 14px;">
        <div>
          <div class="note-title">${msg("Tailscale serve", { id: "overview.note.tailscale" })}</div>
          <div class="muted">
            ${msg("Prefer serve mode to keep the gateway on loopback with tailnet auth.", {
              id: "overview.note.tailscaleHint",
            })}
          </div>
        </div>
        <div>
          <div class="note-title">${msg("Session hygiene", { id: "overview.note.session" })}</div>
          <div class="muted">${msg("Use /new or sessions.patch to reset context.", { id: "overview.note.sessionHint" })}</div>
        </div>
        <div>
          <div class="note-title">${msg("Cron reminders", { id: "overview.note.cron" })}</div>
          <div class="muted">${msg("Use isolated sessions for recurring runs.", { id: "overview.note.cronHint" })}</div>
        </div>
      </div>
    </section>
  `;
}
