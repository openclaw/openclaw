import { html } from "lit";
import type { GatewayHelloOk } from "../gateway.ts";
import type { AppMode } from "../navigation.ts";
import type { UiSettings } from "../storage.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import { formatNextRun } from "../presenter.ts";

export type OverviewProps = {
  mode: AppMode;
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
    | {
        uptimeMs?: number;
        policy?: { tickIntervalMs?: number };
        authMode?: "none" | "token" | "password" | "trusted-proxy";
      }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationHuman(snapshot.uptimeMs) : t("common.na");
  const tick = snapshot?.policy?.tickIntervalMs
    ? `${snapshot.policy.tickIntervalMs}ms`
    : t("common.na");
  const authMode = snapshot?.authMode;
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
        <div class="muted" style="margin-top: 8px">
          This gateway requires auth. Add a token or password, then click Connect.
          <div style="margin-top: 6px">
            <span class="mono">openclaw dashboard --no-open</span> → open the Control UI<br />
            <span class="mono">openclaw doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target="_blank"
              rel="noreferrer"
              title="Control UI auth docs (opens in new tab)"
              >Docs: Control UI auth</a
            >
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        Auth failed. Update the token or password in Control UI settings, then click Connect.
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/dashboard"
            target="_blank"
            rel="noreferrer"
            title="Control UI auth docs (opens in new tab)"
            >Docs: Control UI auth</a
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
        This page is HTTP, so the browser blocks device identity. Use HTTPS (Tailscale Serve) or open
        <span class="mono">http://127.0.0.1:18789</span> on the gateway host.
        <div style="margin-top: 6px">
          If you must stay on HTTP, set
          <span class="mono">gateway.controlUi.allowInsecureAuth: true</span> (token-only).
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/gateway/tailscale"
            target="_blank"
            rel="noreferrer"
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#insecure-http"
            target="_blank"
            rel="noreferrer"
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();

  const isBasic = props.mode === "basic";

  // Simplified form fields for Basic mode
  const gatewayAccessForm = isBasic
    ? html`
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>WebSocket URL</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: v });
              }}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          <label class="field">
            <span>Gateway Token</span>
            <input
              .value=${props.settings.token}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, token: v });
              }}
              placeholder="OPENCLAW_GATEWAY_TOKEN"
            />
          </label>
        </div>
      `
    : html`
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>WebSocket URL</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: v });
              }}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          <label class="field">
            <span>Gateway Token</span>
            <input
              .value=${props.settings.token}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, token: v });
              }}
              placeholder="OPENCLAW_GATEWAY_TOKEN"
            />
          </label>
          <label class="field">
            <span>Password (not stored)</span>
            <input
              type="password"
              .value=${props.password}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onPasswordChange(v);
              }}
              placeholder="system or shared password"
            />
          </label>
          ${
            isTrustedProxy
              ? ""
              : html`
                <label class="field">
                  <span>${t("overview.access.token")}</span>
                  <input
                    .value=${props.settings.token}
                    @input=${(e: Event) => {
                      const v = (e.target as HTMLInputElement).value;
                      props.onSettingsChange({ ...props.settings, token: v });
                    }}
                    placeholder="OPENCLAW_GATEWAY_TOKEN"
                  />
                </label>
                  <span>${t("overview.access.password")}</span>
                    type="password"
                    .value=${props.password}
                      props.onPasswordChange(v);
                    placeholder="system or shared password"
              `
          }
          <label class="field">
            <span>Default Session Key</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSessionKeyChange(v);
              }}
            />
          </label>
        </div>
      `;

  const connectionStatus = props.connected ? "ok" : "warn";
  const connectionText = props.connected ? "Connected" : "Disconnected";

  // Simplified snapshot stats for Basic mode
  const snapshotStats = isBasic
    ? html`
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Status</div>
            <div class="stat-value">
              <span class="log-level ${connectionStatus}">${connectionText}</span>
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Uptime</div>
            <div class="stat-value">${uptime}</div>
          </div>
        </div>
      `
    : html`
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Status</div>
            <div class="stat-value">
              <span class="log-level ${connectionStatus}">${connectionText}</span>
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Uptime</div>
            <div class="stat-value">${uptime}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Tick Interval</div>
            <div class="stat-value">${tick}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Last Channels Refresh</div>
            <div class="stat-value">
              ${props.lastChannelsRefresh ? formatRelativeTimestamp(props.lastChannelsRefresh) : "n/a"}
            </div>
          </div>
        </div>
      `;

  const cronStatus = props.cronEnabled == null ? "n/a" : props.cronEnabled ? "ok" : "warn";
  const cronText = props.cronEnabled == null ? "n/a" : props.cronEnabled ? "Enabled" : "Disabled";

  // Simplified stats row for Basic mode
  const statsRow = isBasic
    ? html`
        <section class="grid grid-cols-2" style="margin-top: 18px;">
          <div class="card stat-card" style="padding: 12px 14px;">
            <div class="stat-label">Instances</div>
            <div class="stat-value">${props.presenceCount}</div>
            <div class="muted">Presence beacons in the last 5 minutes.</div>
          </div>
          <div class="card stat-card" style="padding: 12px 14px;">
            <div class="stat-label">Sessions</div>
            <div class="stat-value">${props.sessionsCount ?? "n/a"}</div>
            <div class="muted">Recent session keys tracked by the gateway.</div>
          </div>
        </section>
      `
    : html`
        <section class="grid grid-cols-3" style="margin-top: 18px;">
          <div class="card stat-card" style="padding: 12px 14px;">
            <div class="stat-label">Instances</div>
            <div class="stat-value">${props.presenceCount}</div>
            <div class="muted">Presence beacons in the last 5 minutes.</div>
          </div>
          <div class="card stat-card" style="padding: 12px 14px;">
            <div class="stat-label">Sessions</div>
            <div class="stat-value">${props.sessionsCount ?? "n/a"}</div>
            <div class="muted">Recent session keys tracked by the gateway.</div>
          </div>
          <div class="card stat-card" style="padding: 12px 14px;">
            <div class="stat-label">Cron</div>
            <div class="stat-value">
              ${props.cronEnabled == null ? "n/a" : html`<span class="log-level ${cronStatus}">${cronText}</span>`}
            </div>
            <div class="muted">Next wake ${formatNextRun(props.cronNext)}</div>
          </div>
        </section>
      `;

  // Notes section only in Advanced mode
  const notesSection = isBasic
    ? null
    : html`
        <section class="card" style="margin-top: 18px">
          <div class="card-title">Notes</div>
          <div class="card-sub">Quick reminders for remote control setups.</div>
          <div class="note-grid" style="margin-top: 14px">
            <div>
              <div class="note-title">Tailscale serve</div>
              <div class="muted">Prefer serve mode to keep the gateway on loopback with tailnet auth.</div>
            </div>
            <div>
              <div class="note-title">Session hygiene</div>
              <div class="muted">Use /new or sessions.patch to reset context.</div>
            </div>
            <div>
              <div class="note-title">Cron reminders</div>
              <div class="muted">Use isolated sessions for recurring runs.</div>
            </div>
          </div>
        </section>
      `;

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Gateway Access</div>
        <div class="card-sub">Where the dashboard connects and how it authenticates.</div>
        ${gatewayAccessForm}
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>Connect</button>
          <button class="btn" @click=${() => props.onRefresh()}>Refresh</button>
          <span class="muted">Click Connect to apply connection changes.</span>
          <button class="btn" @click=${() => props.onConnect()}>${t("common.connect")}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
          <span class="muted">${
            isTrustedProxy ? t("overview.access.trustedProxy") : t("overview.access.connectHint")
          }</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Snapshot</div>
        <div class="card-sub">Latest gateway handshake information.</div>
        ${snapshotStats}
        ${
          props.lastError
            ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${props.lastError}</div>
              ${authHint ?? ""}
              ${insecureContextHint ?? ""}
            </div>`
            : isBasic
              ? null
              : html`
                  <div class="callout" style="margin-top: 14px">
                    Use Channels to link WhatsApp, Telegram, Discord, Signal, or iMessage.
                  </div>
                `
        }
      </div>
    </section>

    ${statsRow}
    ${notesSection}
  `;
}
