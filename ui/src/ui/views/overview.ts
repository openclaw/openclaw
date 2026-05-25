import { html, nothing, type TemplateResult } from "lit";
import { t, i18n, SUPPORTED_LOCALES, type Locale, isSupportedLocale } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import {
  formatCost,
  formatRelativeTimestamp,
  formatDurationHuman,
  formatTokens,
} from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { icons } from "../icons.ts";
import { isMonitoredAuthProvider } from "../model-auth-helpers.ts";
import { formatNextRun } from "../presenter.ts";
import {
  collectQuotaWindows,
  formatQuotaReset,
  quotaLabelNeedsQuotaSuffix,
  type QuotaWindowSummary,
} from "../provider-quota-summary.ts";
import { resolveSessionDisplayName } from "../session-display.ts";
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
};

type OverviewTone = "ok" | "warn" | "danger" | "neutral";

function renderOverviewBadge(label: string | TemplateResult, tone: OverviewTone = "neutral") {
  return html`<span class=${`ov-status-badge ${tone}`}>${label}</span>`;
}

function renderSummaryTile(params: {
  kind?: string;
  label: string;
  value: string | TemplateResult;
  hint: string | TemplateResult;
  tone?: OverviewTone;
  tab?: string;
  onNavigate: (tab: string) => void;
}) {
  const dataKind = params.kind ?? nothing;
  const content = html`
    <span class="ov-summary-tile__label">${params.label}</span>
    <span class="ov-summary-tile__value">${params.value}</span>
    <span class="ov-summary-tile__hint">${params.hint}</span>
  `;
  if (!params.tab) {
    return html`<div class=${`ov-summary-tile ${params.tone ?? "neutral"}`} data-kind=${dataKind}>
      ${content}
    </div>`;
  }
  return html`
    <button
      class=${`ov-summary-tile ov-summary-tile--button ${params.tone ?? "neutral"}`}
      data-kind=${dataKind}
      @click=${() => params.onNavigate(params.tab as string)}
    >
      ${content}
    </button>
  `;
}

function renderEmptyOperatorRow(
  title: string,
  description: string,
  tone: OverviewTone = "neutral",
) {
  return html`
    <div class=${`ov-operator-row ${tone}`}>
      <div>
        <div class="ov-operator-row__title">${title}</div>
        <div class="ov-operator-row__meta">${description}</div>
      </div>
    </div>
  `;
}

const DIGIT_RUN_PART = /^\d{3,}$/;

function blurDigitRuns(value: string): TemplateResult {
  return html`${value
    .split(/(\d{3,})/g)
    .map((part) =>
      DIGIT_RUN_PART.test(part) ? html`<span class="blur-digits">${part}</span>` : part,
    )}`;
}

function tCount(singularKey: string, pluralKey: string, count: number): string {
  return t(count === 1 ? singularKey : pluralKey, { count: String(count) });
}

function quotaLimitLabel(entry: QuotaWindowSummary): string {
  return entry.label && quotaLabelNeedsQuotaSuffix(entry.label)
    ? t("overview.operator.quotaLimitLabel", { label: entry.label })
    : entry.label || t("overview.operator.providerQuota");
}

function quotaIdentity(entry: QuotaWindowSummary): string {
  return [entry.displayName, entry.label].filter(Boolean).join(" · ");
}

function summarizeLogLines(lines: string[]) {
  const visible = lines.slice(-200);
  const errors = visible.filter((line) => /\b(error|fatal|exception|failed)\b/i.test(line)).length;
  const warnings = visible.filter((line) => /\b(warn|warning)\b/i.test(line)).length;
  return { lines: visible.length, errors, warnings };
}

function sessionStatusLabel(session: SessionsListResult["sessions"][number]): {
  label: string;
  tone: OverviewTone;
} {
  if (session.hasActiveRun || session.hasActiveSubagentRun || session.status === "running") {
    return { label: t("common.running"), tone: "ok" };
  }
  if (session.status === "failed" || session.status === "timeout") {
    return {
      label:
        session.status === "timeout"
          ? t("overview.operator.timeout")
          : t("overview.operator.failed"),
      tone: "danger",
    };
  }
  if (session.status === "killed") {
    return { label: t("overview.operator.killed"), tone: "warn" };
  }
  if (session.status === "done") {
    return { label: t("sessionsView.status.done"), tone: "neutral" };
  }
  return {
    label: session.updatedAt ? formatRelativeTimestamp(session.updatedAt) : t("common.na"),
    tone: "neutral",
  };
}

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

  const sessions = props.sessionsResult?.sessions ?? [];
  const activeSessions = sessions.filter(
    (session) =>
      session.hasActiveRun || session.hasActiveSubagentRun || session.status === "running",
  );
  const failedSessions = sessions.filter(
    (session) => session.status === "failed" || session.status === "timeout",
  );
  const recentSessionLimit = 3;
  const recentSessions = sessions.slice(0, recentSessionLimit);
  const remainingRecentSessions = Math.max(0, sessions.length - recentSessions.length);
  const totals = props.usageResult?.totals;
  const totalCost = formatCost(totals?.totalCost);
  const totalTokens = formatTokens(totals?.totalTokens);
  const totalMessages = String(props.usageResult?.aggregates?.messages?.total ?? 0);
  const skills = props.skillsReport?.skills ?? [];
  const enabledSkills = skills.filter((skill) => !skill.disabled).length;
  const blockedSkills = skills.filter((skill) => skill.blockedByAllowlist).length;
  const failedCronJobs = props.cronJobs.filter((job) => job.state?.lastStatus === "error");
  const overdueCronJobs = props.cronJobs.filter(
    (job) =>
      job.enabled && job.state?.nextRunAtMs != null && Date.now() - job.state.nextRunAtMs > 300_000,
  );
  const cronNext = props.cronStatus?.nextWakeAtMs ?? null;
  const authProviders = props.modelAuthStatus?.providers ?? [];
  const monitoredProviders = authProviders.filter(isMonitoredAuthProvider);
  const expiredProviders = monitoredProviders.filter(
    (provider) => provider.status === "expired" || provider.status === "missing",
  );
  const expiringProviders = monitoredProviders.filter((provider) => provider.status === "expiring");
  const quotaWindows = collectQuotaWindows(authProviders);
  const primaryQuota = quotaWindows[0];
  const sameProviderSecondaryQuota = quotaWindows.find(
    (entry) =>
      entry.displayName === primaryQuota?.displayName && entry.label !== primaryQuota?.label,
  );
  const secondaryQuota =
    sameProviderSecondaryQuota ??
    quotaWindows.find(
      (entry) =>
        entry.displayName !== primaryQuota?.displayName || entry.label !== primaryQuota?.label,
    );
  const quotaCardWindows = primaryQuota
    ? quotaWindows
        .filter(
          (entry) => entry.displayName === primaryQuota.displayName || !sameProviderSecondaryQuota,
        )
        .slice(0, 3)
    : [];
  const hasMultipleQuotaWindows = quotaCardWindows.length > 1;
  const primaryQuotaReset = primaryQuota ? formatQuotaReset(primaryQuota.resetAt) : null;
  const primaryQuotaLabel = primaryQuota
    ? quotaLimitLabel(primaryQuota)
    : t("overview.operator.quota");
  const secondaryQuotaHint = secondaryQuota
    ? `${quotaIdentity(secondaryQuota)} ${t("overview.cards.modelAuthUsageLeft", {
        pct: String(secondaryQuota.remaining),
      })}`
    : null;
  const primaryQuotaHint = primaryQuota
    ? [
        quotaIdentity(primaryQuota),
        secondaryQuotaHint,
        !secondaryQuotaHint && primaryQuotaReset
          ? t("overview.operator.quotaResetShort", { time: primaryQuotaReset })
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const visibleAttentionItems = props.attentionItems.slice(0, 3);
  const remainingAttentionItems = Math.max(
    0,
    props.attentionItems.length - visibleAttentionItems.length,
  );
  const primaryQuotaNeedsSuffix = primaryQuota
    ? quotaLabelNeedsQuotaSuffix(primaryQuota.label)
    : false;
  const quotaStatusNote = primaryQuota
    ? primaryQuota.label
      ? primaryQuotaReset
        ? primaryQuotaNeedsSuffix
          ? t("overview.operator.usageQuotaResets", {
              provider: primaryQuota.displayName,
              window: primaryQuota.label,
              time: primaryQuotaReset,
            })
          : t("overview.operator.usageQuotaLabelResets", {
              provider: primaryQuota.displayName,
              label: primaryQuota.label,
              time: primaryQuotaReset,
            })
        : primaryQuotaNeedsSuffix
          ? t("overview.operator.usageQuotaWindow", {
              provider: primaryQuota.displayName,
              window: primaryQuota.label,
            })
          : t("overview.operator.usageQuotaLabel", {
              provider: primaryQuota.displayName,
              label: primaryQuota.label,
            })
      : primaryQuotaReset
        ? t("overview.operator.usageProviderQuotaResets", {
            provider: primaryQuota.displayName,
            time: primaryQuotaReset,
          })
        : t("overview.operator.usageProviderQuota", {
            provider: primaryQuota.displayName,
          })
    : props.modelAuthStatus === null
      ? t("overview.operator.usageQuotaLoading")
      : authProviders.length > 0
        ? t("overview.operator.usageQuotaNoWindows")
        : t("overview.operator.usageQuotaNotConfigured");
  const logSummary = summarizeLogLines(props.overviewLogLines);
  const hasOperationalData =
    props.usageResult != null ||
    props.sessionsResult != null ||
    props.skillsReport != null ||
    props.cronStatus != null ||
    props.modelAuthStatus != null;

  const accessCard = html`
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
      ${!props.connected
        ? html`
            <div class="login-gate__help" style="margin-top: 16px;">
              <div class="login-gate__help-title">${t("overview.connection.title")}</div>
              <ol class="login-gate__steps">
                <li>
                  ${t("overview.connection.step1")} ${renderConnectCommand("openclaw gateway run")}
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
  `;

  const snapshotCard = html`
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
  `;

  return html`
    ${!props.connected
      ? html`<section class="grid">${accessCard}${snapshotCard}</section>`
      : html`
          <section class="ov-summary-strip" aria-label=${t("overview.operator.overviewSummary")}>
            ${renderSummaryTile({
              label: t("overview.operator.gateway"),
              value: html`${renderOverviewBadge(t("common.ok"), "ok")} ${t("common.online")}`,
              hint: t("overview.operator.uptime", { time: uptime }),
              tone: "ok",
              onNavigate: props.onNavigate,
            })}
            ${renderSummaryTile({
              label: t("tabs.channels"),
              value: props.lastChannelsRefresh
                ? html`${renderOverviewBadge(t("overview.operator.fresh"), "ok")}
                  ${t("overview.operator.refreshed")}`
                : html`${renderOverviewBadge(t("common.na"), "neutral")}
                  ${t("sessionsView.unknown")}`,
              hint: props.lastChannelsRefresh
                ? formatRelativeTimestamp(props.lastChannelsRefresh)
                : t("overview.snapshot.channelsHint"),
              tone: props.lastChannelsRefresh ? "ok" : "neutral",
              tab: "channels",
              onNavigate: props.onNavigate,
            })}
            ${renderSummaryTile({
              label: t("overview.operator.activeWork"),
              value: t("overview.operator.activeSessions", {
                active: String(activeSessions.length),
                total: String(props.sessionsResult?.count ?? sessions.length),
              }),
              hint:
                failedSessions.length > 0
                  ? t("overview.operator.failedOrTimedOutCount", {
                      count: String(failedSessions.length),
                    })
                  : t("overview.operator.noFailedActiveSessions"),
              tone:
                failedSessions.length > 0 ? "danger" : activeSessions.length > 0 ? "ok" : "neutral",
              tab: "sessions",
              onNavigate: props.onNavigate,
            })}
            ${renderSummaryTile({
              label: t("overview.stats.cron"),
              value:
                props.cronStatus?.enabled === false
                  ? html`${renderOverviewBadge(t("common.disabled"), "neutral")}`
                  : failedCronJobs.length > 0
                    ? html`${renderOverviewBadge(
                        tCount(
                          "overview.operator.failedCount",
                          "overview.operator.failedCountPlural",
                          failedCronJobs.length,
                        ),
                        "danger",
                      )}
                      ${t("overview.operator.jobsCount", { count: String(props.cronJobs.length) })}`
                    : t("overview.operator.jobsCount", { count: String(props.cronJobs.length) }),
              hint: cronNext ? t("overview.stats.cronNext", { time: formatNextRun(cronNext) }) : "",
              tone: failedCronJobs.length > 0 ? "danger" : "neutral",
              tab: "cron",
              onNavigate: props.onNavigate,
            })}
            ${renderSummaryTile({
              kind: primaryQuota ? "quota" : "usage",
              label: primaryQuota ? primaryQuotaLabel : t("tabs.usage"),
              value: primaryQuota
                ? html`${t("overview.cards.modelAuthUsageLeft", {
                    pct: String(primaryQuota.remaining),
                  })}`
                : t("overview.operator.usageCostMessages", {
                    cost: totalCost,
                    count: totalMessages,
                  }),
              hint: primaryQuota
                ? primaryQuotaHint
                : t("overview.operator.tokensCount", { count: totalTokens }),
              tone:
                primaryQuota?.remaining != null && primaryQuota.remaining <= 25
                  ? "warn"
                  : "neutral",
              tab: "usage",
              onNavigate: props.onNavigate,
            })}
            ${renderSummaryTile({
              label: t("overview.cards.modelAuth"),
              value:
                expiredProviders.length > 0
                  ? html`${renderOverviewBadge(
                      tCount(
                        "overview.operator.expiredCount",
                        "overview.operator.expiredCountPlural",
                        expiredProviders.length,
                      ),
                      "danger",
                    )}`
                  : expiringProviders.length > 0
                    ? html`${renderOverviewBadge(
                        tCount(
                          "overview.operator.expiringCount",
                          "overview.operator.expiringCountPlural",
                          expiringProviders.length,
                        ),
                        "warn",
                      )}`
                    : monitoredProviders.length > 0
                      ? html`${renderOverviewBadge(
                          t("overview.operator.okCount", {
                            count: String(monitoredProviders.length),
                          }),
                          "ok",
                        )}`
                      : html`${renderOverviewBadge(t("common.na"), "neutral")}`,
              hint:
                monitoredProviders.length > 0
                  ? monitoredProviders
                      .map((provider) => provider.displayName)
                      .slice(0, 2)
                      .join(", ")
                  : t("overview.operator.apiKeyOnlyUnavailable"),
              tone:
                expiredProviders.length > 0
                  ? "danger"
                  : expiringProviders.length > 0
                    ? "warn"
                    : "neutral",
              tab: "overview",
              onNavigate: props.onNavigate,
            })}
          </section>

          <section class="ov-operator-grid">
            <div class="card ov-attention ov-operator-attention">
              <div class="card-title">${t("overview.attention.title")}</div>
              <div class="card-sub">${t("overview.operator.attentionSubtitle")}</div>
              <div class="ov-attention-list" style="margin-top: 12px;">
                ${visibleAttentionItems.length > 0
                  ? html`
                      ${visibleAttentionItems.map(
                        (item) => html`
                          <div
                            class=${`ov-attention-item ${item.severity === "error" ? "danger" : item.severity === "warning" ? "warn" : ""}`}
                          >
                            <span class="ov-attention-icon">${icons.radio}</span>
                            <div class="ov-attention-body">
                              <div class="ov-attention-title">${item.title}</div>
                              <div class="muted">${item.description}</div>
                            </div>
                            ${item.href
                              ? html`<a
                                  class="ov-attention-link"
                                  href=${item.href}
                                  target=${item.external ? EXTERNAL_LINK_TARGET : nothing}
                                  rel=${item.external ? buildExternalLinkRel() : nothing}
                                  >${t("common.docs")}</a
                                >`
                              : nothing}
                          </div>
                        `,
                      )}
                      ${remainingAttentionItems > 0
                        ? html`<div class="ov-operator-more">
                            ${tCount(
                              "overview.operator.moreAttentionItem",
                              "overview.operator.moreAttentionItems",
                              remainingAttentionItems,
                            )}
                          </div>`
                        : nothing}
                    `
                  : renderEmptyOperatorRow(
                      t("overview.operator.noUrgentAttention"),
                      t("overview.operator.gatewayAuthClear"),
                      "ok",
                    )}
              </div>
            </div>

            <div class="card">
              <div class="card-title">${t("overview.cards.recentSessions")}</div>
              <div class="card-sub">${t("overview.operator.recentSessionsSubtitle")}</div>
              <div class="ov-operator-list" style="margin-top: 12px;">
                ${recentSessions.length > 0
                  ? recentSessions.map((session) => {
                      const status = sessionStatusLabel(session);
                      return html`
                        <button
                          class="ov-operator-row ov-operator-row--button"
                          @click=${() => props.onNavigate("sessions")}
                        >
                          <div>
                            <div class="ov-operator-row__title">
                              <span class="ov-recent__key"
                                >${blurDigitRuns(
                                  resolveSessionDisplayName(session.key, session),
                                )}</span
                              >
                            </div>
                            <div class="ov-operator-row__meta">
                              ${[session.model, session.kind].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                          ${renderOverviewBadge(status.label, status.tone)}
                        </button>
                      `;
                    })
                  : renderEmptyOperatorRow(
                      t("overview.operator.noSessionsLoaded"),
                      hasOperationalData
                        ? t("overview.operator.noRecentSessionsMatch")
                        : t("overview.operator.sessionDataLoading"),
                    )}
                ${remainingRecentSessions > 0
                  ? html`<button
                      class="ov-operator-more ov-operator-more--button"
                      @click=${() => props.onNavigate("sessions")}
                    >
                      ${tCount(
                        "overview.operator.moreSession",
                        "overview.operator.moreSessions",
                        remainingRecentSessions,
                      )}
                    </button>`
                  : nothing}
              </div>
            </div>

            <div class="card ov-usage-card">
              <div class="card-title">${t("overview.operator.providerUsageTitle")}</div>
              <div class="card-sub">${t("overview.operator.providerUsageSubtitle")}</div>
              <div class="ov-usage-metrics">
                <div class="stat">
                  <div class="stat-label">${primaryQuotaLabel}</div>
                  <div
                    class="stat-value ${primaryQuota?.remaining != null &&
                    primaryQuota.remaining <= 25
                      ? "warn"
                      : "ok"}"
                  >
                    ${primaryQuota ? `${primaryQuota.remaining}%` : t("common.na")}
                  </div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.cards.cost")}</div>
                  <div class="stat-value">${totalCost}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.operator.messages")}</div>
                  <div class="stat-value">${totalMessages}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.operator.tokens")}</div>
                  <div class="stat-value">${totalTokens}</div>
                </div>
              </div>
              ${hasMultipleQuotaWindows
                ? html`<div class="ov-usage-windows">
                    ${quotaCardWindows.map((entry) => {
                      const reset = formatQuotaReset(entry.resetAt);
                      return html`<div class="ov-usage-window">
                        <div>
                          <div class="ov-usage-window__label">
                            ${[entry.displayName, entry.label].filter(Boolean).join(" · ")}
                          </div>
                          ${reset
                            ? html`<div class="ov-usage-window__reset">
                                ${t("overview.operator.quotaResetShort", { time: reset })}
                              </div>`
                            : nothing}
                        </div>
                        <strong
                          class=${entry.remaining <= 25
                            ? "ov-usage-window__remaining warn"
                            : "ov-usage-window__remaining ok"}
                        >
                          ${t("overview.cards.modelAuthUsageLeft", {
                            pct: String(entry.remaining),
                          })}
                        </strong>
                      </div>`;
                    })}
                  </div>`
                : nothing}
              <div class="ov-usage-note">${quotaStatusNote}</div>
            </div>
          </section>

          <section class="ov-operator-grid ov-operator-grid--secondary">
            <div class="card">
              <div class="card-title">${t("tabs.cron")}</div>
              <div class="card-sub">${t("overview.operator.cronSubtitle")}</div>
              <div class="ov-operator-list" style="margin-top: 12px;">
                ${failedCronJobs.length > 0
                  ? failedCronJobs.slice(0, 4).map(
                      (job) => html`
                        <button
                          class="ov-operator-row ov-operator-row--button danger"
                          @click=${() => props.onNavigate("cron")}
                        >
                          <div>
                            <div class="ov-operator-row__title">${job.name}</div>
                            <div class="ov-operator-row__meta">
                              ${job.state?.lastErrorReason ??
                              job.state?.lastError ??
                              t("overview.operator.lastRunFailed")}
                            </div>
                          </div>
                          ${renderOverviewBadge(t("overview.operator.failed"), "danger")}
                        </button>
                      `,
                    )
                  : overdueCronJobs.length > 0
                    ? overdueCronJobs.slice(0, 4).map(
                        (job) => html`
                          <button
                            class="ov-operator-row ov-operator-row--button warn"
                            @click=${() => props.onNavigate("cron")}
                          >
                            <div>
                              <div class="ov-operator-row__title">${job.name}</div>
                              <div class="ov-operator-row__meta">
                                ${t("overview.operator.nextRunOverdue")}
                              </div>
                            </div>
                            ${renderOverviewBadge(t("overview.operator.overdue"), "warn")}
                          </button>
                        `,
                      )
                    : renderEmptyOperatorRow(
                        t("overview.operator.noFailedCronJobs"),
                        cronNext
                          ? t("overview.stats.cronNext", { time: formatNextRun(cronNext) })
                          : t("overview.operator.noNextWakeScheduled"),
                        "ok",
                      )}
              </div>
            </div>

            <div class="card">
              <div class="card-title">${t("overview.operator.connectorsSkillsTitle")}</div>
              <div class="card-sub">${t("overview.operator.connectorsSkillsSubtitle")}</div>
              <div class="ov-operator-list" style="margin-top: 12px;">
                ${renderEmptyOperatorRow(
                  t("overview.cards.modelAuth"),
                  expiredProviders.length > 0
                    ? expiredProviders.map((provider) => provider.displayName).join(", ")
                    : expiringProviders.length > 0
                      ? expiringProviders.map((provider) => provider.displayName).join(", ")
                      : monitoredProviders.length > 0
                        ? t("overview.operator.monitoredProvidersOk", {
                            count: String(monitoredProviders.length),
                          })
                        : t("overview.operator.noExpiringProviders"),
                  expiredProviders.length > 0
                    ? "danger"
                    : expiringProviders.length > 0
                      ? "warn"
                      : "ok",
                )}
                ${renderEmptyOperatorRow(
                  t("overview.cards.skills"),
                  skills.length > 0
                    ? blockedSkills > 0
                      ? t("overview.operator.skillsEnabledBlocked", {
                          enabled: String(enabledSkills),
                          total: String(skills.length),
                          blocked: String(blockedSkills),
                        })
                      : t("overview.operator.skillsEnabled", {
                          enabled: String(enabledSkills),
                          total: String(skills.length),
                        })
                    : t("overview.operator.skillStatusUnavailable"),
                  blockedSkills > 0 ? "warn" : "neutral",
                )}
              </div>
            </div>

            <div class="card">
              <div class="card-title">${t("overview.operator.logEventAnomaliesTitle")}</div>
              <div class="card-sub">${t("overview.operator.logEventAnomaliesSubtitle")}</div>
              <div class="stat-grid" style="margin-top: 16px;">
                <div class="stat">
                  <div class="stat-label">${t("overview.operator.events")}</div>
                  <div class="stat-value">${props.eventLog.length}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.operator.logLines")}</div>
                  <div class="stat-value">${logSummary.lines}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.operator.warnings")}</div>
                  <div class="stat-value ${logSummary.warnings > 0 ? "warn" : "ok"}">
                    ${logSummary.warnings}
                  </div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.operator.errors")}</div>
                  <div class="stat-value ${logSummary.errors > 0 ? "warn" : "ok"}">
                    ${logSummary.errors}
                  </div>
                </div>
              </div>
            </div>
          </section>

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

          <div class="ov-section-divider"></div>

          <section class="grid ov-setup-grid">${accessCard}${snapshotCard}</section>
        `}
  `;
}
