import { html, nothing } from "lit";
import { t, i18n, type Locale } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { icons } from "../icons.ts";
import type { UiSettings } from "../storage.ts";
import type {
  AttentionItem,
  CronJob,
  CronStatus,
  SessionsListResult,
  SessionsUsageResult,
  SkillStatusReport,
} from "../types.ts";
import { renderOverviewAttention } from "./overview-attention.ts";
import { renderOverviewCards } from "./overview-cards.ts";
import { renderOverviewEventLog } from "./overview-event-log.ts";
import { renderOverviewLogTail } from "./overview-log-tail.ts";

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
  // New dashboard data
  usageResult: SessionsUsageResult | null;
  sessionsResult: SessionsListResult | null;
  skillsReport: SkillStatusReport | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  attentionItems: AttentionItem[];
  eventLog: EventLogEntry[];
  overviewLogLines: string[];
  streamMode: boolean;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
  onNavigate: (tab: string) => void;
  onRefreshLogs: () => void;
  onToggleStreamMode: () => void;
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
    ? `${(snapshot.policy.tickIntervalMs / 1000).toFixed(snapshot.policy.tickIntervalMs % 1000 === 0 ? 0 : 1)}s`
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
          ${t("overview.auth.required")}
          <div style="margin-top: 6px">
            <span class="mono">openclaw dashboard --no-open</span> → tokenized URL<br />
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
        ${t("overview.auth.failed", { command: "openclaw dashboard --no-open" })}
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
        ${t("overview.insecure.hint", { url: "http://127.0.0.1:18789" })}
        <div style="margin-top: 6px">
          ${t("overview.insecure.stayHttp", { config: "gateway.controlUi.allowInsecureAuth: true" })}
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

  const currentLocale = i18n.getLocale();

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">${t("overview.access.title")}</div>
        <div class="card-sub">${t("overview.access.subtitle")}</div>
        <div class="form-grid ${props.streamMode ? "redacted" : ""}" style="margin-top: 16px;">
          <label class="field">
            <span>${t("overview.access.wsUrl")}</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: v });
              }}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          ${
            isTrustedProxy
              ? ""
              : html`
                <label class="field">
                  <span>${t("overview.access.token")}</span>
                  <input
                    type="password"
                    autocomplete="off"
                    .value=${props.settings.token}
                    @input=${(e: Event) => {
                      const v = (e.target as HTMLInputElement).value;
                      props.onSettingsChange({ ...props.settings, token: v });
                    }}
                    placeholder="OPENCLAW_GATEWAY_TOKEN"
                  />
                </label>
                <label class="field">
                  <span>${t("overview.access.password")}</span>
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
              `
          }
          <label class="field">
            <span>${t("overview.access.sessionKey")}</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSessionKeyChange(v);
              }}
            />
          </label>
          <label class="field">
            <span>${t("overview.access.language")}</span>
            <select
              .value=${currentLocale}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value as Locale;
                void i18n.setLocale(v);
                props.onSettingsChange({ ...props.settings, locale: v });
              }}
            >
              <option value="en">${t("languages.en")}</option>
              <option value="zh-CN">${t("languages.zhCN")}</option>
              <option value="zh-TW">${t("languages.zhTW")}</option>
              <option value="pt-BR">${t("languages.ptBR")}</option>
            </select>
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>${t("common.connect")}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
          <span class="muted">${
            isTrustedProxy ? t("overview.access.trustedProxy") : t("overview.access.connectHint")
          }</span>
        </div>
        ${
          !props.connected
            ? html`
                <div style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 14px;">
                  <div style="font-weight: 600; font-size: 13px; margin-bottom: 10px;">${t("overview.connection.title")}</div>
                  <ol class="muted" style="margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.8;">
                    <li>${t("overview.connection.step1")}
                      <div class="mono" style="font-size: 12px; margin: 4px 0 6px;">openclaw gateway run</div>
                    </li>
                    <li>${t("overview.connection.step2")}
                      <div class="mono" style="font-size: 12px; margin: 4px 0 6px;">openclaw dashboard --no-open</div>
                    </li>
                    <li>${t("overview.connection.step3")}</li>
                    <li>${t("overview.connection.step4")}
                      <div class="mono" style="font-size: 12px; margin: 4px 0 6px;">openclaw doctor --generate-gateway-token</div>
                    </li>
                  </ol>
                  <div class="muted" style="font-size: 12px; margin-top: 10px;">
                    ${t("overview.connection.docsHint")}
                    <a
                      class="session-link"
                      href="https://docs.openclaw.ai/web/dashboard"
                      target="_blank"
                      rel="noreferrer"
                    >${t("overview.connection.docsLink")}</a>
                  </div>
                </div>
              `
            : nothing
        }
      </div>

      <div class="card">
        <div class="card-title">${t("overview.snapshot.title")}</div>
        <div class="card-sub">${t("overview.snapshot.subtitle")}</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.status")}</div>
            <div class="stat-value ${props.connected ? "ok" : "warn"}">
              ${props.connected ? t("common.ok") : t("common.offline")}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.uptime")}</div>
            <div class="stat-value">${uptime}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.tickInterval")}</div>
            <div class="stat-value">${tick}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.lastChannelsRefresh")}</div>
            <div class="stat-value">
              ${props.lastChannelsRefresh ? formatRelativeTimestamp(props.lastChannelsRefresh) : t("common.na")}
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
                  ${t("overview.snapshot.channelsHint")}
                </div>
              `
        }
      </div>
    </section>

    ${
      props.streamMode
        ? html`<div class="callout ov-stream-banner" style="margin-top: 18px;">
          <span class="nav-item__icon">${icons.radio}</span>
          ${t("overview.streamMode.active")}
          <button class="btn btn--sm" style="margin-left: auto;" @click=${() => props.onToggleStreamMode()}>
            ${t("overview.streamMode.disable")}
          </button>
        </div>`
        : nothing
    }

    <div class="ov-section-divider"></div>

    ${renderOverviewCards({
      usageResult: props.usageResult,
      sessionsResult: props.sessionsResult,
      skillsReport: props.skillsReport,
      cronJobs: props.cronJobs,
      cronStatus: props.cronStatus,
      presenceCount: props.presenceCount,
      redacted: props.streamMode,
      onNavigate: props.onNavigate,
    })}

    ${renderOverviewAttention({ items: props.attentionItems })}

    <div class="ov-section-divider"></div>

    <div class="ov-bottom-grid" style="margin-top: 18px;">
      ${renderOverviewEventLog({
        events: props.eventLog,
        redacted: props.streamMode,
      })}

      ${renderOverviewLogTail({
        lines: props.overviewLogLines,
        redacted: props.streamMode,
        onRefreshLogs: props.onRefreshLogs,
      })}
    </div>

  `;
}
