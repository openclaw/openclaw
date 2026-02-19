import { html } from "lit";
import { t, i18n, type Locale } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { getOnboardingNextStep, getOnboardingSteps, getOnboardingProgress } from "../onboarding-flow.ts";
import { formatNextRun } from "../presenter.ts";
import type { UiSettings } from "../storage.ts";

export type OverviewProps = {
  onboarding?: boolean;
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
  onOpenChannels?: () => void;
  onOpenChat?: () => void;
  onOpenConsent?: () => void;
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
  const showSetupFlow = Boolean(props.onboarding);
  const onboardingSteps = getOnboardingSteps({
    connected: props.connected,
    channelsLastSuccess: props.lastChannelsRefresh,
    sessionsCount: props.sessionsCount,
  });
  const onboardingProgress = getOnboardingProgress(onboardingSteps);
  const nextOnboardingStep = getOnboardingNextStep(onboardingSteps);
  const nextOnboardingLabel = nextOnboardingStep
    ? t(`overview.setupFlow.${nextOnboardingStep.key}`)
    : t("overview.setupFlow.review");
  const gatewayReady = onboardingSteps.some((step) => step.key === "gateway" && step.done);
  const integrationsReady = onboardingSteps.some((step) => step.key === "integrations" && step.done);
  const firstRunReady = onboardingSteps.some((step) => step.key === "firstRun" && step.done);

  const runNextOnboardingAction = () => {
    if (!nextOnboardingStep) {
      props.onOpenConsent?.();
      return;
    }
    if (nextOnboardingStep.key === "gateway") {
      props.onConnect();
      return;
    }
    if (nextOnboardingStep.key === "integrations") {
      props.onOpenChannels?.();
      return;
    }
    props.onOpenChat?.();
  };

  return html`
    ${
      showSetupFlow
        ? html`
            <section class="card" data-testid="onboarding-setup-flow">
              <div class="card-title">${t("overview.setupFlow.title")}</div>
              <div class="card-sub">${t("overview.setupFlow.subtitle")}</div>
              <div class="muted" style="margin-top: 8px;" data-testid="onboarding-setup-flow-progress">
                ${t("overview.setupFlow.progress", {
                  done: onboardingProgress.done.toString(),
                  total: onboardingProgress.total.toString(),
                })}
              </div>
              <div class="note-grid" style="margin-top: 12px;">
                <div>
                  <div class="note-title">
                    1. ${t("overview.setupFlow.gateway")}
                    <span class="muted" data-testid="onboarding-setup-step-gateway">
                      (${gatewayReady ? t("common.ok") : t("common.offline")})
                    </span>
                  </div>
                  <div class="muted">${t("overview.setupFlow.gatewayHint")}</div>
                </div>
                <div>
                  <div class="note-title">
                    2. ${t("overview.setupFlow.integrations")}
                    <span class="muted" data-testid="onboarding-setup-step-integrations">
                      (${integrationsReady ? t("common.ok") : t("common.na")})
                    </span>
                  </div>
                  <div class="muted">${t("overview.setupFlow.integrationsHint")}</div>
                </div>
                <div>
                  <div class="note-title">
                    3. ${t("overview.setupFlow.firstRun")}
                    <span class="muted" data-testid="onboarding-setup-step-firstRun">
                      (${firstRunReady ? t("common.ok") : t("common.na")})
                    </span>
                  </div>
                  <div class="muted">${t("overview.setupFlow.firstRunHint")}</div>
                </div>
              </div>
              <div class="row" style="margin-top: 12px;">
                <button class="btn" data-testid="onboarding-setup-flow-next" @click=${runNextOnboardingAction}>
                  ${t("overview.setupFlow.next")}: ${nextOnboardingLabel}
                </button>
                <button class="btn" data-testid="onboarding-setup-flow-connect" @click=${() => props.onConnect()}>
                  ${t("common.connect")}
                </button>
                <button class="btn" data-testid="onboarding-setup-flow-integrations" @click=${() => props.onOpenChannels?.()}>
                  ${t("overview.setupFlow.openIntegrations")}
                </button>
                <button
                  class="btn"
                  data-testid="onboarding-setup-flow-chat"
                  ?disabled=${!props.connected || !integrationsReady}
                  @click=${() => props.onOpenChat?.()}
                >
                  ${t("overview.setupFlow.openChat")}
                </button>
                <button
                  class="btn"
                  data-testid="onboarding-setup-flow-consent"
                  ?disabled=${!firstRunReady}
                  @click=${() => props.onOpenConsent?.()}
                >
                  ${t("overview.setupFlow.openConsent")}
                </button>
              </div>
            </section>
          `
        : ""
    }

    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">${t("overview.access.title")}</div>
        <div class="card-sub">${t("overview.access.subtitle")}</div>
        <form
          @submit=${(e: Event) => {
            e.preventDefault();
          }}
          style="margin-top: 16px;"
        >
          <div class="form-grid">
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
        </form>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>${t("common.connect")}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
          <span class="muted">${
            isTrustedProxy ? t("overview.access.trustedProxy") : t("overview.access.connectHint")
          }</span>
        </div>
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

    <section class="grid grid-cols-3" style="margin-top: 18px;">
      <div class="card stat-card">
        <div class="stat-label">${t("overview.stats.instances")}</div>
        <div class="stat-value">${props.presenceCount}</div>
        <div class="muted">${t("overview.stats.instancesHint")}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">${t("overview.stats.sessions")}</div>
        <div class="stat-value">${props.sessionsCount ?? t("common.na")}</div>
        <div class="muted">${t("overview.stats.sessionsHint")}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">${t("overview.stats.cron")}</div>
        <div class="stat-value">
          ${props.cronEnabled == null ? t("common.na") : props.cronEnabled ? t("common.enabled") : t("common.disabled")}
        </div>
        <div class="muted">${t("overview.stats.cronNext", { time: formatNextRun(props.cronNext) })}</div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t("overview.notes.title")}</div>
      <div class="card-sub">${t("overview.notes.subtitle")}</div>
      <div class="note-grid" style="margin-top: 14px;">
        <div>
          <div class="note-title">${t("overview.notes.tailscaleTitle")}</div>
          <div class="muted">
            ${t("overview.notes.tailscaleText")}
          </div>
        </div>
        <div>
          <div class="note-title">${t("overview.notes.sessionTitle")}</div>
          <div class="muted">${t("overview.notes.sessionText")}</div>
        </div>
        <div>
          <div class="note-title">${t("overview.notes.cronTitle")}</div>
          <div class="muted">${t("overview.notes.cronText")}</div>
        </div>
      </div>
    </section>
  `;
}
