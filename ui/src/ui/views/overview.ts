import { html, nothing } from "lit";
import { t, i18n, SUPPORTED_LOCALES, type Locale } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
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
import { renderOverviewCards, renderOverviewRecentSessions } from "./overview-cards.ts";
import { renderOverviewEventLog } from "./overview-event-log.ts";
import {
  resolveAuthHintKind,
  shouldShowInsecureContextHint,
  shouldShowPairingHint,
} from "./overview-hints.ts";
import { renderOverviewLogTail } from "./overview-log-tail.ts";

type OverviewAttentionFilter = "all" | "critical" | "watch";
type OverviewDetailPane = "activity" | "logs" | "access";

type OverviewViewState = {
  attentionFilter: OverviewAttentionFilter;
  detailPane: OverviewDetailPane;
};

function createOverviewViewState(): OverviewViewState {
  return {
    attentionFilter: "all",
    detailPane: "activity",
  };
}

const vs = createOverviewViewState();

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
  onRequestUpdate?: () => void;
};

function matchesAttentionFilter(item: AttentionItem, filter: OverviewAttentionFilter) {
  if (filter === "critical") {
    return item.severity === "error";
  }
  if (filter === "watch") {
    return item.severity !== "error";
  }
  return true;
}

function renderOverviewSegmentButton(
  active: boolean,
  label: string,
  icon: unknown,
  onClick: () => void,
) {
  return html`
    <button
      type="button"
      class="ov-segmented__btn ${active ? "active" : ""}"
      aria-pressed=${active}
      @click=${onClick}
    >
      <span class="ov-segmented__icon">${icon}</span>
      <span>${label}</span>
    </button>
  `;
}

function renderOverviewQuickAction(
  label: string,
  icon: unknown,
  onClick: () => void,
  tone: "default" | "primary" = "default",
) {
  return html`
    <button
      type="button"
      class="ov-intervention-action ${tone === "primary" ? "ov-intervention-action--primary" : ""}"
      @click=${onClick}
    >
      <span class="ov-intervention-action__icon">${icon}</span>
      <span>${label}</span>
    </button>
  `;
}

function renderOverviewEmptyState(title: string, description: string) {
  return html`
    <div class="ov-empty-state">
      <div class="ov-empty-state__title">${title}</div>
      <div class="ov-empty-state__copy">${description}</div>
    </div>
  `;
}

function renderOverviewAccessPane(
  props: OverviewProps,
  currentLocale: Locale,
  isTrustedProxy: boolean,
  pairingHint: ReturnType<typeof html> | null,
  authHint: ReturnType<typeof html> | null,
  insecureContextHint: ReturnType<typeof html> | null,
) {
  return html`
    <div class="ov-pane-header">
      <div>
        <div class="ov-pane-eyebrow">Delivery path</div>
        <h3 class="ov-pane-title">${t("overview.access.title")}</h3>
        <div class="ov-pane-sub">${t("overview.access.subtitle")}</div>
      </div>
    </div>

    <div class="ov-access-grid">
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

      ${
        isTrustedProxy
          ? nothing
          : html`
              <label class="field">
                <span>${t("overview.access.token")}</span>
                <div class="ov-secret-field">
                  <input
                    type=${props.showGatewayToken ? "text" : "password"}
                    autocomplete="off"
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
                    title=${props.showGatewayToken ? "Hide token" : "Show token"}
                    aria-label="Toggle token visibility"
                    aria-pressed=${props.showGatewayToken}
                    @click=${props.onToggleGatewayTokenVisibility}
                  >
                    ${props.showGatewayToken ? icons.eye : icons.eyeOff}
                  </button>
                </div>
              </label>

              <label class="field">
                <span>${t("overview.access.password")}</span>
                <div class="ov-secret-field">
                  <input
                    type=${props.showGatewayPassword ? "text" : "password"}
                    autocomplete="off"
                    .value=${props.password}
                    @input=${(e: Event) => {
                      const v = (e.target as HTMLInputElement).value;
                      props.onPasswordChange(v);
                    }}
                    placeholder="system or shared password"
                  />
                  <button
                    type="button"
                    class="btn btn--icon ${props.showGatewayPassword ? "active" : ""}"
                    title=${props.showGatewayPassword ? "Hide password" : "Show password"}
                    aria-label="Toggle password visibility"
                    aria-pressed=${props.showGatewayPassword}
                    @click=${props.onToggleGatewayPasswordVisibility}
                  >
                    ${props.showGatewayPassword ? icons.eye : icons.eyeOff}
                  </button>
                </div>
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
          ${SUPPORTED_LOCALES.map((loc) => {
            const key = loc.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
            return html`<option value=${loc}>${t(`languages.${key}`)}</option>`;
          })}
        </select>
      </label>
    </div>

    <div class="ov-access-actions">
      <button class="btn primary" @click=${() => props.onConnect()}>${t("common.connect")}</button>
      <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
      <span class="muted">
        ${isTrustedProxy ? t("overview.access.trustedProxy") : t("overview.access.connectHint")}
      </span>
    </div>

    ${
      props.lastError
        ? html`
            <div class="callout danger ov-pane-callout">
              <div>${props.lastError}</div>
              ${pairingHint ?? nothing}
              ${authHint ?? nothing}
              ${insecureContextHint ?? nothing}
            </div>
          `
        : html`
            <div class="callout ov-pane-callout">${t("overview.snapshot.channelsHint")}</div>
          `
    }

    ${
      !props.connected
        ? html`
            <div class="login-gate__help ov-pane-help">
              <div class="login-gate__help-title">${t("overview.connection.title")}</div>
              <ol class="login-gate__steps">
                <li>${t("overview.connection.step1")}<code>openclaw gateway run</code></li>
                <li>${t("overview.connection.step2")}<code>openclaw dashboard --no-open</code></li>
                <li>${t("overview.connection.step3")}</li>
                <li>${t("overview.connection.step4")}<code>openclaw doctor --generate-gateway-token</code></li>
              </ol>
              <div class="login-gate__docs">
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
  `;
}

function renderOverviewActivityPane(props: OverviewProps) {
  const eventLog =
    props.eventLog.length > 0
      ? renderOverviewEventLog({ events: props.eventLog })
      : renderOverviewEmptyState(
          "No live events yet",
          "New session activity, delivery changes, and watchdog events will appear here.",
        );

  return html`
    <div class="ov-pane-header">
      <div>
        <div class="ov-pane-eyebrow">Activity</div>
        <h3 class="ov-pane-title">Recent operator activity</h3>
        <div class="ov-pane-sub">Inspect the latest seats, sessions, and stream events before you intervene.</div>
      </div>
    </div>

    <div class="ov-detail-stack">
      ${
        (props.sessionsResult?.sessions.length ?? 0) > 0
          ? renderOverviewRecentSessions(props.sessionsResult, { max: 6 })
          : renderOverviewEmptyState(
              "No recent seats",
              "As new sessions arrive they will appear here for quick triage.",
            )
      }
      ${eventLog}
    </div>
  `;
}

function renderOverviewLogsPane(props: OverviewProps) {
  return html`
    <div class="ov-pane-header">
      <div>
        <div class="ov-pane-eyebrow">Logs</div>
        <h3 class="ov-pane-title">Gateway tail</h3>
        <div class="ov-pane-sub">Use the log tail for low-level verification after the summary looks stable.</div>
      </div>
    </div>

    <div class="ov-detail-stack">
      ${
        props.overviewLogLines.length > 0
          ? renderOverviewLogTail({
              lines: props.overviewLogLines,
              onRefreshLogs: props.onRefreshLogs,
            })
          : renderOverviewEmptyState(
              "No log lines loaded",
              "Refresh logs after the gateway reconnects or when a seat starts misbehaving.",
            )
      }
    </div>
  `;
}

function renderOverviewDetailPane(
  props: OverviewProps,
  currentLocale: Locale,
  isTrustedProxy: boolean,
  pairingHint: ReturnType<typeof html> | null,
  authHint: ReturnType<typeof html> | null,
  insecureContextHint: ReturnType<typeof html> | null,
) {
  if (vs.detailPane === "logs") {
    return renderOverviewLogsPane(props);
  }
  if (vs.detailPane === "access") {
    return renderOverviewAccessPane(
      props,
      currentLocale,
      isTrustedProxy,
      pairingHint,
      authHint,
      insecureContextHint,
    );
  }
  return renderOverviewActivityPane(props);
}

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
  const requestUpdate = props.onRequestUpdate ?? (() => {});

  const pairingHint = (() => {
    if (!shouldShowPairingHint(props.connected, props.lastError, props.lastErrorCode)) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${t("overview.pairing.hint")}
        <div style="margin-top: 6px">
          <span class="mono">openclaw devices list</span><br />
          <span class="mono">openclaw devices approve &lt;requestId&gt;</span>
        </div>
        <div style="margin-top: 6px; font-size: 12px;">
          ${t("overview.pairing.mobileHint")}
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Device pairing docs (opens in new tab)"
            >Docs: Device pairing</a
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
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
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
    if (!shouldShowInsecureContextHint(props.connected, props.lastError, props.lastErrorCode)) {
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
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#insecure-http"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();

  const currentLocale = i18n.getLocale();
  const criticalCount = props.attentionItems.filter((item) => item.severity === "error").length;
  const watchCount = props.attentionItems.length - criticalCount;
  const filteredAttentionItems = props.attentionItems.filter((item) =>
    matchesAttentionFilter(item, vs.attentionFilter),
  );
  const sessionsLabel =
    props.sessionsCount == null ? "Sessions n/a" : `${props.sessionsCount} active seats`;
  const automationLabel =
    props.cronEnabled == null
      ? "Automation n/a"
      : props.cronEnabled
        ? props.cronNext
          ? `Next automation ${formatRelativeTimestamp(props.cronNext)}`
          : "Automation armed"
        : "Automation paused";

  return html`
    <div class="ov-shell">
      <section class="card ov-summary-section">
        <div class="ov-section-head ov-section-head--summary">
          <div>
            <div class="ov-section-kicker">Summary</div>
            <div class="card-title">Watchdog at a glance</div>
            <div class="card-sub">
              A quieter system readout for release monitoring and operator triage.
            </div>
          </div>
          <div class="ov-summary-pills">
            <span class="pill ${props.connected ? "ok" : "danger"}">
              <span class="statusDot"></span>
              ${props.connected ? t("common.ok") : t("common.offline")}
            </span>
            <span class="pill">${sessionsLabel}</span>
            <span class="pill">${automationLabel}</span>
          </div>
        </div>

        <div class="ov-summary-strip">
          <div class="ov-summary-stat">
            <span class="ov-summary-stat__label">${t("overview.snapshot.uptime")}</span>
            <span class="ov-summary-stat__value">${uptime}</span>
          </div>
          <div class="ov-summary-stat">
            <span class="ov-summary-stat__label">${t("overview.snapshot.tickInterval")}</span>
            <span class="ov-summary-stat__value">${tick}</span>
          </div>
          <div class="ov-summary-stat">
            <span class="ov-summary-stat__label">${t("overview.snapshot.lastChannelsRefresh")}</span>
            <span class="ov-summary-stat__value">
              ${
                props.lastChannelsRefresh
                  ? formatRelativeTimestamp(props.lastChannelsRefresh)
                  : t("common.na")
              }
            </span>
          </div>
          <div class="ov-summary-stat">
            <span class="ov-summary-stat__label">Auth mode</span>
            <span class="ov-summary-stat__value">
              ${isTrustedProxy ? t("overview.access.trustedProxy") : (authMode ?? t("common.na"))}
            </span>
          </div>
        </div>

        ${
          props.lastError
            ? html`
                <div class="callout danger ov-summary-callout">
                  <strong>Attention required.</strong> ${props.lastError}
                </div>
              `
            : html`
                <div class="callout ov-summary-callout">
                  Channels, seats, and automations are in a stable observation loop.
                </div>
              `
        }

        ${renderOverviewCards({
          usageResult: props.usageResult,
          sessionsResult: props.sessionsResult,
          skillsReport: props.skillsReport,
          cronJobs: props.cronJobs,
          cronStatus: props.cronStatus,
          presenceCount: props.presenceCount,
          onNavigate: props.onNavigate,
          showRecentSessions: false,
        })}
      </section>

      <section class="card ov-attention-section">
        <div class="ov-section-head">
          <div>
            <div class="ov-section-kicker">Seats needing attention</div>
            <div class="card-sub">
              Surface only the channels, agents, or sessions that deserve operator time right now.
            </div>
          </div>
          <div class="ov-segmented" role="group" aria-label="Attention filter">
            ${renderOverviewSegmentButton(
              vs.attentionFilter === "all",
              `All ${props.attentionItems.length}`,
              icons.monitor,
              () => {
                vs.attentionFilter = "all";
                requestUpdate();
              },
            )}
            ${renderOverviewSegmentButton(
              vs.attentionFilter === "critical",
              `Critical ${criticalCount}`,
              icons.radio,
              () => {
                vs.attentionFilter = "critical";
                requestUpdate();
              },
            )}
            ${renderOverviewSegmentButton(
              vs.attentionFilter === "watch",
              `Watch ${watchCount}`,
              icons.scrollText,
              () => {
                vs.attentionFilter = "watch";
                requestUpdate();
              },
            )}
          </div>
        </div>

        ${renderOverviewAttention({
          items: filteredAttentionItems,
          embedded: true,
          emptyState: renderOverviewEmptyState(
            "Nothing noisy right now",
            "Seats that need intervention will appear here with their next recommended action.",
          ),
        })}
      </section>

      <section class="ov-detail-layout">
        <aside class="card ov-detail-sidebar">
          <div class="ov-section-kicker">Detail / intervention</div>
          <div class="card-title">Choose a working surface</div>
          <div class="card-sub">
            This is the operator pane: inspect activity, pull logs, or reconnect delivery safely.
          </div>

          <div class="ov-detail-nav" role="group" aria-label="Detail pane">
            ${renderOverviewSegmentButton(
              vs.detailPane === "activity",
              "Activity",
              icons.monitor,
              () => {
                vs.detailPane = "activity";
                requestUpdate();
              },
            )}
            ${renderOverviewSegmentButton(
              vs.detailPane === "logs",
              "Logs",
              icons.scrollText,
              () => {
                vs.detailPane = "logs";
                requestUpdate();
              },
            )}
            ${renderOverviewSegmentButton(
              vs.detailPane === "access",
              "Access",
              icons.settings,
              () => {
                vs.detailPane = "access";
                requestUpdate();
              },
            )}
          </div>

          <div class="ov-intervention-actions">
            ${renderOverviewQuickAction("Refresh watchdog", icons.loader, () => props.onRefresh(), "primary")}
            ${renderOverviewQuickAction("Open session view", icons.messageSquare, () => props.onNavigate("chat"))}
            ${renderOverviewQuickAction("Review automation", icons.zap, () => props.onNavigate("cron"))}
          </div>
        </aside>

        <div class="card ov-detail-pane">
          ${renderOverviewDetailPane(
            props,
            currentLocale,
            isTrustedProxy,
            pairingHint,
            authHint,
            insecureContextHint,
          )}
        </div>
      </section>
    </div>
  `;
}
