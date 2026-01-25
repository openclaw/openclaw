import { html } from "lit";

import type { GatewayHelloOk } from "../gateway";
import { formatAgo, formatDurationMs } from "../format";
import { formatNextRun } from "../presenter";
import type { UiSettings } from "../storage";
import { icon } from "../icons";

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
  const uptime = snapshot?.uptimeMs ? formatDurationMs(snapshot.uptimeMs) : "n/a";
  const tick = snapshot?.policy?.tickIntervalMs
    ? `${snapshot.policy.tickIntervalMs}ms`
    : "n/a";
  const authHint = (() => {
    if (props.connected || !props.lastError) return null;
    const lower = props.lastError.toLowerCase();
    const authFailed = lower.includes("unauthorized") || lower.includes("connect failed");
    if (!authFailed) return null;
    const hasToken = Boolean(props.settings.token.trim());
    const hasPassword = Boolean(props.password.trim());
    if (!hasToken && !hasPassword) {
      return html`
        <div class="muted" style="margin-top: 8px;">
          This gateway requires auth. Add a token or password, then click Connect.
          <div style="margin-top: 6px;">
            <span class="mono">clawdbot dashboard --no-open</span> → tokenized URL<br />
            <span class="mono">clawdbot doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px;">
            <a
              class="session-link"
              href="https://docs.clawd.bot/web/dashboard"
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
      <div class="muted" style="margin-top: 8px;">
        Auth failed. Re-copy a tokenized URL with
        <span class="mono">clawdbot dashboard --no-open</span>, or update the token,
        then click Connect.
        <div style="margin-top: 6px;">
          <a
            class="session-link"
            href="https://docs.clawd.bot/web/dashboard"
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
    if (props.connected || !props.lastError) return null;
    const isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true;
    if (isSecureContext !== false) return null;
    const lower = props.lastError.toLowerCase();
    if (!lower.includes("secure context") && !lower.includes("device identity required")) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px;">
        This page is HTTP, so the browser blocks device identity. Use HTTPS (Tailscale Serve) or
        open <span class="mono">http://127.0.0.1:18789</span> on the gateway host.
        <div style="margin-top: 6px;">
          If you must stay on HTTP, set
          <span class="mono">gateway.controlUi.allowInsecureAuth: true</span> (token-only).
        </div>
        <div style="margin-top: 6px;">
          <a
            class="session-link"
            href="https://docs.clawd.bot/gateway/tailscale"
            target="_blank"
            rel="noreferrer"
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.clawd.bot/web/control-ui#insecure-http"
            target="_blank"
            rel="noreferrer"
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();

  return html`
    <section class="overview-grid">
      <div class="card card--gateway">
        <div class="card-header">
          <div class="card-header__icon">${icon("link", { size: 20 })}</div>
          <div>
            <div class="card-title">Gateway Access</div>
            <div class="card-sub">Connection and authentication settings</div>
          </div>
        </div>
        <div class="form-grid" style="margin-top: 20px;">
          <label class="field field--modern">
            <span class="field__label">WebSocket URL</span>
            <div class="field__input-wrapper">
              ${icon("server", { size: 16, class: "field__icon" })}
              <input
                class="field__input"
                .value=${props.settings.gatewayUrl}
                @input=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  props.onSettingsChange({ ...props.settings, gatewayUrl: v });
                }}
                placeholder="ws://100.x.y.z:18789"
              />
            </div>
          </label>
          <label class="field field--modern">
            <span class="field__label">Gateway Token</span>
            <div class="field__input-wrapper">
              ${icon("zap", { size: 16, class: "field__icon" })}
              <input
                class="field__input"
                .value=${props.settings.token}
                @input=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  props.onSettingsChange({ ...props.settings, token: v });
                }}
                placeholder="CLAWDBOT_GATEWAY_TOKEN"
              />
            </div>
          </label>
          <label class="field field--modern">
            <span class="field__label">Password (not stored)</span>
            <div class="field__input-wrapper">
              ${icon("user", { size: 16, class: "field__icon" })}
              <input
                class="field__input"
                type="password"
                .value=${props.password}
                @input=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  props.onPasswordChange(v);
                }}
                placeholder="system or shared password"
              />
            </div>
          </label>
          <label class="field field--modern">
            <span class="field__label">Default Session Key</span>
            <div class="field__input-wrapper">
              ${icon("file-text", { size: 16, class: "field__icon" })}
              <input
                class="field__input"
                .value=${props.settings.sessionKey}
                @input=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  props.onSessionKeyChange(v);
                }}
              />
            </div>
          </label>
        </div>
        <div class="card-actions">
          <button class="btn btn--primary" @click=${() => props.onConnect()}>
            ${icon("link", { size: 16 })}
            <span>Connect</span>
          </button>
          <button class="btn btn--secondary" @click=${() => props.onRefresh()}>
            ${icon("refresh-cw", { size: 16 })}
            <span>Refresh</span>
          </button>
          <span class="muted">Click Connect to apply changes</span>
        </div>
      </div>

      <div class="card card--snapshot">
        <div class="card-header">
          <div class="card-header__icon">${icon("layout-dashboard", { size: 20 })}</div>
          <div>
            <div class="card-title">Snapshot</div>
            <div class="card-sub">Gateway handshake information</div>
          </div>
        </div>
        <div class="stat-grid stat-grid--compact" style="margin-top: 20px;">
          <div class="stat stat--modern ${props.connected ? "stat--ok" : "stat--warn"}">
            <div class="stat__icon">
              ${props.connected
                ? icon("check", { size: 18 })
                : icon("alert-circle", { size: 18 })}
            </div>
            <div class="stat__content">
              <div class="stat-label">Status</div>
              <div class="stat-value">
                ${props.connected ? "Connected" : "Disconnected"}
              </div>
            </div>
          </div>
          <div class="stat stat--modern">
            <div class="stat__icon">${icon("clock", { size: 18 })}</div>
            <div class="stat__content">
              <div class="stat-label">Uptime</div>
              <div class="stat-value">${uptime}</div>
            </div>
          </div>
          <div class="stat stat--modern">
            <div class="stat__icon">${icon("zap", { size: 18 })}</div>
            <div class="stat__content">
              <div class="stat-label">Tick Interval</div>
              <div class="stat-value">${tick}</div>
            </div>
          </div>
          <div class="stat stat--modern">
            <div class="stat__icon">${icon("refresh-cw", { size: 18 })}</div>
            <div class="stat__content">
              <div class="stat-label">Last Refresh</div>
              <div class="stat-value">
                ${props.lastChannelsRefresh
                  ? formatAgo(props.lastChannelsRefresh)
                  : "n/a"}
              </div>
            </div>
          </div>
        </div>
        ${props.lastError
          ? html`<div class="callout callout--danger" style="margin-top: 16px;">
              <div class="callout__icon">${icon("alert-triangle", { size: 18 })}</div>
              <div class="callout__content">
                <div>${props.lastError}</div>
                ${authHint ?? ""}
                ${insecureContextHint ?? ""}
              </div>
            </div>`
          : html`<div class="callout callout--info" style="margin-top: 16px;">
              <div class="callout__icon">${icon("info", { size: 18 })}</div>
              <div class="callout__content">
                Use Channels to link WhatsApp, Telegram, Discord, Signal, or iMessage.
              </div>
            </div>`}
      </div>
    </section>

    <section class="overview-stats">
      <div class="stat-card stat-card--large">
        <div class="stat-card__icon">${icon("radio", { size: 24 })}</div>
        <div class="stat-card__value">${props.presenceCount}</div>
        <div class="stat-card__label">Instances</div>
        <div class="stat-card__desc">Presence beacons in the last 5 minutes</div>
      </div>
      <div class="stat-card stat-card--large">
        <div class="stat-card__icon">${icon("file-text", { size: 24 })}</div>
        <div class="stat-card__value">${props.sessionsCount ?? "n/a"}</div>
        <div class="stat-card__label">Sessions</div>
        <div class="stat-card__desc">Recent session keys tracked by gateway</div>
      </div>
      <div class="stat-card stat-card--large ${props.cronEnabled ? "stat-card--active" : ""}">
        <div class="stat-card__icon">${icon("clock", { size: 24 })}</div>
        <div class="stat-card__value">
          ${props.cronEnabled == null
            ? "n/a"
            : props.cronEnabled
              ? "Enabled"
              : "Disabled"}
        </div>
        <div class="stat-card__label">Cron</div>
        <div class="stat-card__desc">Next wake ${formatNextRun(props.cronNext)}</div>
      </div>
    </section>

    <section class="card card--notes">
      <div class="card-header">
        <div class="card-header__icon">${icon("book-open", { size: 20 })}</div>
        <div>
          <div class="card-title">Quick Tips</div>
          <div class="card-sub">Reminders for remote control setups</div>
        </div>
      </div>
      <div class="notes-grid">
        <div class="note-card">
          <div class="note-card__icon">${icon("server", { size: 18 })}</div>
          <div class="note-card__content">
            <div class="note-card__title">Tailscale Serve</div>
            <div class="note-card__desc">
              Prefer serve mode to keep the gateway on loopback with tailnet auth.
            </div>
          </div>
        </div>
        <div class="note-card">
          <div class="note-card__icon">${icon("file-text", { size: 18 })}</div>
          <div class="note-card__content">
            <div class="note-card__title">Session Hygiene</div>
            <div class="note-card__desc">
              Use /new or sessions.patch to reset context.
            </div>
          </div>
        </div>
        <div class="note-card">
          <div class="note-card__icon">${icon("clock", { size: 18 })}</div>
          <div class="note-card__content">
            <div class="note-card__title">Cron Reminders</div>
            <div class="note-card__desc">
              Use isolated sessions for recurring runs.
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
