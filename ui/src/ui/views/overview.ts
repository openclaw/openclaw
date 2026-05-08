import { html, nothing } from "lit";
import { t, i18n, SUPPORTED_LOCALES, type Locale, isSupportedLocale } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import type { GmailAuthStatusResult } from "../controllers/gmail-auth.ts";
import type { GmailDraftForm } from "../controllers/gmail-draft.ts";
import type { GmailInboxItem, GmailThreadView } from "../controllers/gmail-inbox.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { icons } from "../icons.ts";
import type { UiSettings } from "../storage.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type {
  AttentionItem,
  CronJob,
  CronStatus,
  ModelAuthStatusResult,
  SessionsListResult,
  SessionsUsageResult,
  SkillStatusReport,
} from "../types.ts";
import { renderConnectCommand } from "./connect-command.ts";
import { renderOverviewAttention } from "./overview-attention.ts";
import { renderOverviewCards } from "./overview-cards.ts";
import { renderOverviewEventLog } from "./overview-event-log.ts";
import {
  resolveAuthHintKind,
  type PairingHint,
  resolvePairingHint,
  shouldShowInsecureContextHint,
} from "./overview-hints.ts";
import { renderOverviewLogTail } from "./overview-log-tail.ts";

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  lastErrorCode: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  warnQueryToken: boolean;
  // New dashboard data
  modelAuthStatus: ModelAuthStatusResult | null;
  gmailAuthStatus: GmailAuthStatusResult | null;
  gmailAuthLoading: boolean;
  gmailAuthConnectPending: boolean;
  gmailAuthError: string | null;
  gmailInboxLoading: boolean;
  gmailInboxError: string | null;
  gmailInboxItems: GmailInboxItem[];
  gmailInboxQuery: string;
  gmailInboxUnreadOnly: boolean;
  gmailSelectedThreadId: string | null;
  gmailThreadLoading: boolean;
  gmailThreadError: string | null;
  gmailSelectedThread: GmailThreadView | null;
  gmailDraftForm: GmailDraftForm;
  gmailDraftSaving: boolean;
  gmailDraftError: string | null;
  gmailDraftSuccess: string | null;
  gmailSendConfirmOpen: boolean;
  gmailSendPending: boolean;
  gmailSendError: string | null;
  gmailSendSuccess: string | null;
  usageResult: SessionsUsageResult | null;
  sessionsResult: SessionsListResult | null;
  skillsReport: SkillStatusReport | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  attentionItems: AttentionItem[];
  eventLog: EventLogEntry[];
  overviewLogLines: string[];
  showGatewayToken: boolean;
  showGatewayPassword: boolean;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onToggleGatewayTokenVisibility: () => void;
  onToggleGatewayPasswordVisibility: () => void;
  onConnect: () => void;
  onRefresh: () => void;
  onNavigate: (tab: string) => void;
  onRefreshLogs: () => void;
  onGmailConnect: () => void;
  onGmailRefresh: () => void;
  onGmailInboxFiltersChange: (patch: { query?: string; unreadOnly?: boolean }) => void;
  onGmailInboxSearch: () => void;
  onGmailSelectThread: (threadId: string) => void;
  onGmailDraftFieldChange: (patch: Partial<GmailDraftForm>) => void;
  onGmailDraftReply: () => void;
  onGmailDraftReset: () => void;
  onGmailDraftSave: () => void;
  onGmailSendOpenConfirm: () => void;
  onGmailSendCloseConfirm: () => void;
  onGmailSendConfirm: () => void;
};

const PAIRING_HINT_COPY: Record<
  PairingHint["kind"],
  {
    titleKey: string | null;
    summaryKey: string | null;
  }
> = {
  "pairing-required": {
    titleKey: null,
    summaryKey: null,
  },
  "scope-upgrade-pending": {
    titleKey: "overview.pairing.scopeUpgradeTitle",
    summaryKey: "overview.pairing.scopeUpgradeSummary",
  },
  "role-upgrade-pending": {
    titleKey: "overview.pairing.roleUpgradeTitle",
    summaryKey: "overview.pairing.roleUpgradeSummary",
  },
  "metadata-upgrade-pending": {
    titleKey: "overview.pairing.metadataUpgradeTitle",
    summaryKey: "overview.pairing.metadataUpgradeSummary",
  },
};

export function renderOverview(props: OverviewProps) {
  const snapshot = props.hello?.snapshot as
    | {
        uptimeMs?: number;
        authMode?: "none" | "token" | "password" | "trusted-proxy";
      }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationHuman(snapshot.uptimeMs) : t("common.na");
  const tickIntervalMs = props.hello?.policy?.tickIntervalMs;
  const tick = tickIntervalMs
    ? `${(tickIntervalMs / 1000).toFixed(tickIntervalMs % 1000 === 0 ? 0 : 1)}s`
    : t("common.na");
  const authMode = snapshot?.authMode;
  const isTrustedProxy = authMode === "trusted-proxy";

  const pairingHint = (() => {
    const pairingState = resolvePairingHint(props.connected, props.lastError, props.lastErrorCode);
    if (!pairingState) {
      return null;
    }
    const copy = PAIRING_HINT_COPY[pairingState.kind];
    const title = copy.titleKey ? t(copy.titleKey) : t("overview.pairing.hint");
    return html`
      <div class="muted" style="margin-top: 8px">
        ${title}
        ${copy.summaryKey
          ? html`<div style="margin-top: 6px">${t(copy.summaryKey)}</div>`
          : nothing}
        <div style="margin-top: 6px">
          ${pairingState.requestId
            ? html`<span class="mono">openclaw devices approve ${pairingState.requestId}</span
                ><br />`
            : nothing}
          <span class="mono">openclaw devices list</span>
        </div>
        <div style="margin-top: 6px; font-size: 12px;">${t("overview.pairing.mobileHint")}</div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title=${t("overview.pairing.docsTitle")}
            >${t("overview.pairing.docsLink")}</a
          >
        </div>
      </div>
    `;
  })();

  const authHint = (() => {
    const authHintKind = resolveAuthHintKind({
      connected: props.connected,
      lastError: props.lastError,
      lastErrorCode: props.lastErrorCode,
      hasToken: Boolean(props.settings.token.trim()),
      hasPassword: Boolean(props.password.trim()),
    });
    if (authHintKind == null) {
      return null;
    }
    if (authHintKind === "required") {
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
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
              title=${t("overview.connection.authDocsTitle")}
              >${t("overview.connection.authDocsLink")}</a
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
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title=${t("overview.connection.authDocsTitle")}
            >${t("overview.connection.authDocsLink")}</a
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
    if (!shouldShowInsecureContextHint(props.connected, props.lastError, props.lastErrorCode)) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${t("overview.insecure.hint", { url: "http://127.0.0.1:18789" })}
        <div style="margin-top: 6px">
          ${t("overview.insecure.stayHttp", {
            config: "gateway.controlUi.allowInsecureAuth: true",
          })}
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/gateway/tailscale"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title=${t("overview.connection.tailscaleDocsTitle")}
            >${t("overview.connection.tailscaleDocsLink")}</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#insecure-http"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title=${t("overview.connection.insecureHttpDocsTitle")}
            >${t("overview.connection.insecureHttpDocsLink")}</a
          >
        </div>
      </div>
    `;
  })();

  const queryTokenHint = (() => {
    if (props.connected || !props.lastError || !props.warnQueryToken) {
      return null;
    }
    const lower = normalizeLowercaseStringOrEmpty(props.lastError);
    const authFailed = lower.includes("unauthorized") || lower.includes("device identity required");
    if (!authFailed) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        Auth token must be passed as a URL fragment:
        <span class="mono">#token=&lt;token&gt;</span>. Query parameters (<span class="mono"
          >?token=</span
        >) may appear in server logs.
      </div>
    `;
  })();

  const currentLocale = isSupportedLocale(props.settings.locale)
    ? props.settings.locale
    : i18n.getLocale();

  return html`
    <section class="grid">
      <div class="card">
        <div class="card-title">${t("overview.access.title")}</div>
        <div class="card-sub">${t("overview.access.subtitle")}</div>
        <div class="ov-access-grid" style="margin-top: 16px;">
          <label class="field ov-access-grid__full">
            <span>${t("overview.access.wsUrl")}</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({
                  ...props.settings,
                  gatewayUrl: v,
                  token: v.trim() === props.settings.gatewayUrl.trim() ? props.settings.token : "",
                });
              }}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          ${isTrustedProxy
            ? ""
            : html`
                <label class="field">
                  <span>${t("overview.access.token")}</span>
                  <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <input
                      type=${props.showGatewayToken ? "text" : "password"}
                      autocomplete="off"
                      style="flex: 1 1 0%; min-width: 0; box-sizing: border-box;"
                      .value=${props.settings.token}
                      @input=${(e: Event) => {
                        const v = (e.target as HTMLInputElement).value;
                        props.onSettingsChange({ ...props.settings, token: v });
                      }}
                      placeholder="OPENCLAW_GATEWAY_TOKEN"
                    />
                    <button
                      type="button"
                      class="btn btn--icon ${props.showGatewayToken ? "active" : ""}"
                      style="flex-shrink: 0; width: 36px; height: 36px; box-sizing: border-box;"
                      title=${props.showGatewayToken
                        ? t("overview.access.hideToken")
                        : t("overview.access.showToken")}
                      aria-label=${t("overview.access.toggleTokenVisibility")}
                      aria-pressed=${props.showGatewayToken}
                      @click=${props.onToggleGatewayTokenVisibility}
                    >
                      ${props.showGatewayToken ? icons.eye : icons.eyeOff}
                    </button>
                  </div>
                </label>
                <label class="field">
                  <span>${t("overview.access.password")}</span>
                  <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <input
                      type=${props.showGatewayPassword ? "text" : "password"}
                      autocomplete="off"
                      style="flex: 1 1 0%; min-width: 0; width: 100%; box-sizing: border-box;"
                      .value=${props.password}
                      @input=${(e: Event) => {
                        const v = (e.target as HTMLInputElement).value;
                        props.onPasswordChange(v);
                      }}
                      placeholder=${t("overview.access.passwordPlaceholder")}
                    />
                    <button
                      type="button"
                      class="btn btn--icon ${props.showGatewayPassword ? "active" : ""}"
                      style="flex-shrink: 0; width: 36px; height: 36px; box-sizing: border-box;"
                      title=${props.showGatewayPassword
                        ? t("overview.access.hidePassword")
                        : t("overview.access.showPassword")}
                      aria-label=${t("overview.access.togglePasswordVisibility")}
                      aria-pressed=${props.showGatewayPassword}
                      @click=${props.onToggleGatewayPasswordVisibility}
                    >
                      ${props.showGatewayPassword ? icons.eye : icons.eyeOff}
                    </button>
                  </div>
                </label>
              `}
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
              ${SUPPORTED_LOCALES.map((loc) => {
                const key = loc.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
                return html`<option value=${loc} ?selected=${currentLocale === loc}>
                  ${t(`languages.${key}`)}
                </option>`;
              })}
            </select>
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>${t("common.connect")}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
          <span class="muted"
            >${isTrustedProxy
              ? t("overview.access.trustedProxy")
              : t("overview.access.connectHint")}</span
          >
        </div>
        <div
          style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border, rgba(255,255,255,0.08));"
        >
          <div
            style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;"
          >
            <div>
              <div class="card-title" style="font-size: 15px; margin: 0;">Gmail</div>
              <div class="muted" style="margin-top: 4px;">
                ${props.gmailAuthStatus?.connected
                  ? (props.gmailAuthStatus.profiles[0]?.email ?? "Connected")
                  : props.gmailAuthLoading
                    ? "Checking Gmail connection…"
                    : "Connect Gmail for inbox, search, threads, and drafts."}
              </div>
            </div>
            <div class="row" style="gap: 8px;">
              <button
                class="btn"
                ?disabled=${props.gmailAuthLoading}
                @click=${() => props.onGmailRefresh()}
              >
                Refresh Gmail
              </button>
              <button
                class="btn btn--primary"
                ?disabled=${!props.connected || props.gmailAuthConnectPending}
                @click=${() => props.onGmailConnect()}
              >
                ${props.gmailAuthConnectPending
                  ? "Connecting Gmail…"
                  : props.gmailAuthStatus?.connected
                    ? "Reconnect Gmail"
                    : "Connect Gmail"}
              </button>
            </div>
          </div>
          ${props.gmailAuthError
            ? html`<div class="pill danger" style="margin-top: 10px;">${props.gmailAuthError}</div>`
            : nothing}
        </div>
        ${!props.connected
          ? html`
              <div class="login-gate__help" style="margin-top: 16px;">
                <div class="login-gate__help-title">${t("overview.connection.title")}</div>
                <ol class="login-gate__steps">
                  <li>
                    ${t("overview.connection.step1")}
                    ${renderConnectCommand("openclaw gateway run")}
                  </li>
                  <li>
                    ${t("overview.connection.step2")} ${renderConnectCommand("openclaw dashboard")}
                  </li>
                  <li>${t("overview.connection.step3")}</li>
                  <li>
                    ${t("overview.connection.step4")}<code
                      >openclaw doctor --generate-gateway-token</code
                    >
                  </li>
                </ol>
                <div class="login-gate__docs">
                  ${t("overview.connection.docsHint")}
                  <a
                    class="session-link"
                    href="https://docs.openclaw.ai/web/dashboard"
                    target="_blank"
                    rel="noreferrer"
                    >${t("overview.connection.docsLink")}</a
                  >
                </div>
              </div>
            `
          : nothing}
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
              ${props.lastChannelsRefresh
                ? formatRelativeTimestamp(props.lastChannelsRefresh)
                : t("common.na")}
            </div>
          </div>
        </div>
        ${props.lastError
          ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${props.lastError}</div>
              ${pairingHint ?? ""} ${authHint ?? ""} ${insecureContextHint ?? ""}
              ${queryTokenHint ?? ""}
            </div>`
          : html`
              <div class="callout" style="margin-top: 14px">
                ${t("overview.snapshot.channelsHint")}
              </div>
            `}
      </div>
    </section>

    <div class="ov-section-divider"></div>

    ${props.gmailAuthStatus?.connected
      ? html`
          <div class="card">
            <div
              style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;"
            >
              <div>
                <div class="card-title">Gmail inbox</div>
                <div class="card-sub">Recent inbox threads from the connected Gmail account.</div>
              </div>
              <button
                class="btn"
                ?disabled=${props.gmailInboxLoading}
                @click=${() => props.onGmailRefresh()}
              >
                ${props.gmailInboxLoading ? "Refreshing…" : "Refresh inbox"}
              </button>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; align-items:end;">
              <label class="field" style="flex:1 1 260px;">
                <span>Search inbox</span>
                <input
                  .value=${props.gmailInboxQuery}
                  @input=${(e: Event) =>
                    props.onGmailInboxFiltersChange({
                      query: (e.target as HTMLInputElement).value,
                    })}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                      props.onGmailInboxSearch();
                    }
                  }}
                  placeholder="from:, subject:, keywords…"
                />
              </label>
              <label
                class="field"
                style="display:flex; align-items:center; gap:8px; min-height:36px;"
              >
                <input
                  type="checkbox"
                  .checked=${props.gmailInboxUnreadOnly}
                  @change=${(e: Event) =>
                    props.onGmailInboxFiltersChange({
                      unreadOnly: (e.target as HTMLInputElement).checked,
                    })}
                />
                <span>Unread only</span>
              </label>
              <button
                class="btn"
                ?disabled=${props.gmailInboxLoading}
                @click=${() => props.onGmailInboxSearch()}
              >
                Search
              </button>
            </div>
            ${props.gmailInboxError
              ? html`<div class="pill danger" style="margin-top: 12px;">
                  ${props.gmailInboxError}
                </div>`
              : nothing}
            <div
              style="display:grid; grid-template-columns:minmax(280px, 360px) minmax(0, 1fr); gap:16px; margin-top:16px; align-items:start;"
            >
              <div style="display:flex; flex-direction:column; gap:8px;">
                ${props.gmailInboxItems.length === 0
                  ? html`<div class="muted">
                      ${props.gmailInboxLoading
                        ? "Loading inbox…"
                        : "No inbox messages loaded yet."}
                    </div>`
                  : props.gmailInboxItems.map(
                      (item) => html`
                        <button
                          class="btn"
                          style="text-align:left; display:block; padding:12px; border:${props.gmailSelectedThreadId ===
                          item.threadId
                            ? "1px solid var(--accent, #6ea8fe)"
                            : "1px solid var(--border, rgba(255,255,255,0.08))"}; background:${props.gmailSelectedThreadId ===
                          item.threadId
                            ? "rgba(110,168,254,0.08)"
                            : "transparent"};"
                          @click=${() => props.onGmailSelectThread(item.threadId)}
                        >
                          <div
                            style="display:flex; align-items:center; justify-content:space-between; gap:8px;"
                          >
                            <strong style="font-size:13px;">${item.subject}</strong>
                            ${item.unread ? html`<span class="pill">Unread</span>` : nothing}
                          </div>
                          <div class="muted" style="margin-top:4px; font-size:12px;">
                            ${item.from}
                          </div>
                          <div style="margin-top:6px; font-size:13px;">
                            ${item.snippet || "No preview available."}
                          </div>
                        </button>
                      `,
                    )}
              </div>
              <div>
                ${props.gmailThreadError
                  ? html`<div class="pill danger">${props.gmailThreadError}</div>`
                  : props.gmailThreadLoading
                    ? html`<div class="muted">Loading thread…</div>`
                    : !props.gmailSelectedThread || props.gmailSelectedThread.messages.length === 0
                      ? html`<div class="muted">Select a thread to read it here.</div>`
                      : html`
                          <div style="display:flex; flex-direction:column; gap:16px;">
                            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                              <div>
                                <div class="card-title" style="font-size: 15px; margin: 0;">Thread</div>
                                <div class="muted" style="margin-top: 4px;">Read the thread, then save a reply draft below.</div>
                              </div>
                              <button class="btn" @click=${() => props.onGmailDraftReply()}>Reply as draft</button>
                            </div>
                            ${props.gmailSelectedThread.messages.map(
                              (message) => html`
                                <article
                                  style="padding:14px; border:1px solid var(--border, rgba(255,255,255,0.08)); border-radius:12px;"
                                >
                                  <div
                                    style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;"
                                  >
                                    <strong>${message.subject}</strong>
                                    ${message.unread
                                      ? html`<span class="pill">Unread</span>`
                                      : nothing}
                                  </div>
                                  <div class="muted" style="margin-top:6px; font-size:12px;">
                                    From:
                                    ${message.from}${message.to
                                      ? html`<span> · To: ${message.to}</span>`
                                      : nothing}${message.date
                                      ? html`<span> · ${message.date}</span>`
                                      : nothing}
                                  </div>
                                  <div
                                    style="margin-top:10px; white-space:pre-wrap; line-height:1.45; font-size:13px;"
                                  >
                                    ${message.bodyText ||
                                    message.snippet ||
                                    "No body preview available."}
                                  </div>
                                </article>
                              `,
                            )}
                            <div style="padding:14px; border:1px solid var(--border, rgba(255,255,255,0.08)); border-radius:12px;">
                              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                                <div>
                                  <div class="card-title" style="font-size: 15px; margin: 0;">Draft reply</div>
                                  <div class="muted" style="margin-top: 4px;">Create a Gmail draft from this thread.</div>
                                </div>
                                <div class="row" style="gap:8px;">
                                  <button class="btn" @click=${() => props.onGmailDraftReset()}>Clear</button>
                                  <button class="btn" ?disabled=${props.gmailSendPending} @click=${() => props.onGmailSendOpenConfirm()}>
                                    Send…
                                  </button>
                                  <button class="btn btn--primary" ?disabled=${props.gmailDraftSaving} @click=${() => props.onGmailDraftSave()}>
                                    ${props.gmailDraftSaving ? "Saving draft…" : "Save draft"}
                                  </button>
                                </div>
                              </div>
                              ${
                                props.gmailSendConfirmOpen
                                  ? html`<div class="callout warn" style="margin-top:10px;">
                                      <div><strong>Send this email now?</strong></div>
                                      <div class="muted" style="margin-top:6px;">
                                        This will send the message immediately from your Gmail
                                        account.
                                      </div>
                                      <div class="row" style="gap:8px; margin-top:10px;">
                                        <button
                                          class="btn"
                                          @click=${() => props.onGmailSendCloseConfirm()}
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          class="btn btn--primary"
                                          ?disabled=${props.gmailSendPending}
                                          @click=${() => props.onGmailSendConfirm()}
                                        >
                                          ${props.gmailSendPending ? "Sending…" : "Confirm send"}
                                        </button>
                                      </div>
                                    </div>`
                                  : nothing
                              }
                              </div>
                              <div style="display:grid; gap:10px; margin-top:14px;">
                                <label class="field">
                                  <span>To</span>
                                  <input
                                    .value=${props.gmailDraftForm.to}
                                    @input=${(e: Event) =>
                                      props.onGmailDraftFieldChange({
                                        to: (e.target as HTMLInputElement).value,
                                      })}
                                  />
                                </label>
                                <label class="field">
                                  <span>Subject</span>
                                  <input
                                    .value=${props.gmailDraftForm.subject}
                                    @input=${(e: Event) =>
                                      props.onGmailDraftFieldChange({
                                        subject: (e.target as HTMLInputElement).value,
                                      })}
                                  />
                                </label>
                                <label class="field">
                                  <span>Body</span>
                                  <textarea
                                    rows="10"
                                    .value=${props.gmailDraftForm.textBody}
                                    @input=${(e: Event) =>
                                      props.onGmailDraftFieldChange({
                                        textBody: (e.target as HTMLTextAreaElement).value,
                                      })}
                                    style="width:100%; box-sizing:border-box; resize:vertical;"
                                  ></textarea>
                                </label>
                              </div>
                              ${
                                props.gmailDraftError
                                  ? html`<div class="pill danger" style="margin-top:10px;">
                                      ${props.gmailDraftError}
                                    </div>`
                                  : nothing
                              }
                              ${
                                props.gmailDraftSuccess
                                  ? html`<div class="pill ok" style="margin-top:10px;">
                                      ${props.gmailDraftSuccess}
                                    </div>`
                                  : nothing
                              }
                              ${
                                props.gmailSendError
                                  ? html`<div class="pill danger" style="margin-top:10px;">
                                      ${props.gmailSendError}
                                    </div>`
                                  : nothing
                              }
                              ${
                                props.gmailSendSuccess
                                  ? html`<div class="pill ok" style="margin-top:10px;">
                                      ${props.gmailSendSuccess}
                                    </div>`
                                  : nothing
                              }
                            </div>
                          </div>
                        `}
              </div>
            </div>
          </div>
          <div class="ov-section-divider"></div>
        `
      : nothing}
    ${renderOverviewCards({
      usageResult: props.usageResult,
      sessionsResult: props.sessionsResult,
      skillsReport: props.skillsReport,
      cronJobs: props.cronJobs,
      cronStatus: props.cronStatus,
      modelAuthStatus: props.modelAuthStatus,
      presenceCount: props.presenceCount,
      onNavigate: props.onNavigate,
    })}
    ${renderOverviewAttention({ items: props.attentionItems })}

    <div class="ov-section-divider"></div>

    <div class="ov-bottom-grid">
      ${renderOverviewEventLog({
        events: props.eventLog,
      })}
      ${renderOverviewLogTail({
        lines: props.overviewLogLines,
        onRefreshLogs: props.onRefreshLogs,
      })}
    </div>
  `;
}
