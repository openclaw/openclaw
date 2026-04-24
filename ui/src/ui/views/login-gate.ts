import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";
import { normalizeBasePath } from "../navigation.ts";
import { agentLogoUrl } from "./agents-utils.ts";
import { renderConnectCommand } from "./connect-command.ts";
import { resolveAuthHintKind } from "./overview-hints.ts";

export function renderLoginGate(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const faviconSrc = agentLogoUrl(basePath);
  const authHintKind = resolveAuthHintKind({
    connected: state.connected,
    lastError: state.lastError,
    lastErrorCode: state.lastErrorCode,
    hasToken: Boolean(state.settings.token?.trim()),
    hasPassword: Boolean(state.password?.trim()),
  });
  const showAuthHint = authHintKind === "required" || authHintKind === "failed";

  return html`
    <div class="login-gate">
      <div class="login-gate__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${faviconSrc} alt="OpenClaw" />
          <div class="login-gate__title">OpenClaw</div>
          <div class="login-gate__sub">${t("login.subtitle")}</div>
        </div>

        <div class="login-gate__intro">
          <div class="login-gate__eyebrow">Operator access</div>
          <p class="login-gate__lead">${t("overview.connection.lead")}</p>
        </div>

        <div class="login-gate__callout-grid">
          <section class="login-gate__callout-card">
            <div class="login-gate__callout-title">
              ${t("overview.connection.beforeStartTitle")}
            </div>
            <ul class="login-gate__bullets">
              <li>${t("overview.connection.beforeStartToken")}</li>
              <li>${t("overview.connection.beforeStartHost")}</li>
              <li>${t("overview.connection.beforeStartPassword")}</li>
            </ul>
          </section>
          <section class="login-gate__callout-card">
            <div class="login-gate__callout-title">
              ${t("overview.connection.afterConnectTitle")}
            </div>
            <p class="login-gate__callout-body">${t("overview.connection.afterConnectBody")}</p>
          </section>
        </div>

        <div class="login-gate__form">
          <label class="field">
            <span>${t("overview.access.wsUrl")}</span>
            <input
              .value=${state.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                state.applySettings({ ...state.settings, gatewayUrl: v });
              }}
              placeholder="ws://127.0.0.1:18789"
            />
          </label>
          <label class="field">
            <span>${t("overview.access.token")}</span>
            <div class="login-gate__secret-row">
              <input
                type=${state.loginShowGatewayToken ? "text" : "password"}
                autocomplete="off"
                spellcheck="false"
                .value=${state.settings.token}
                @input=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  state.applySettings({ ...state.settings, token: v });
                }}
                placeholder="OPENCLAW_GATEWAY_TOKEN (${t("login.passwordPlaceholder")})"
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    state.connect();
                  }
                }}
              />
              <button
                type="button"
                class="btn btn--icon ${state.loginShowGatewayToken ? "active" : ""}"
                title=${state.loginShowGatewayToken ? t("login.hideToken") : t("login.showToken")}
                aria-label=${t("login.toggleTokenVisibility")}
                aria-pressed=${state.loginShowGatewayToken}
                @click=${() => {
                  state.loginShowGatewayToken = !state.loginShowGatewayToken;
                }}
              >
                ${state.loginShowGatewayToken ? icons.eye : icons.eyeOff}
              </button>
            </div>
          </label>
          <label class="field">
            <span>${t("overview.access.password")}</span>
            <div class="login-gate__secret-row">
              <input
                type=${state.loginShowGatewayPassword ? "text" : "password"}
                autocomplete="off"
                spellcheck="false"
                .value=${state.password}
                @input=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  state.password = v;
                }}
                placeholder="${t("login.passwordPlaceholder")}"
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    state.connect();
                  }
                }}
              />
              <button
                type="button"
                class="btn btn--icon ${state.loginShowGatewayPassword ? "active" : ""}"
                title=${state.loginShowGatewayPassword
                  ? t("login.hidePassword")
                  : t("login.showPassword")}
                aria-label=${t("login.togglePasswordVisibility")}
                aria-pressed=${state.loginShowGatewayPassword}
                @click=${() => {
                  state.loginShowGatewayPassword = !state.loginShowGatewayPassword;
                }}
              >
                ${state.loginShowGatewayPassword ? icons.eye : icons.eyeOff}
              </button>
            </div>
          </label>
          <button class="btn primary login-gate__connect" @click=${() => state.connect()}>
            ${t("common.connect")}
          </button>
        </div>
        ${state.lastError
          ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${state.lastError}</div>
              ${showAuthHint
                ? html`<div class="login-gate__error-hint">
                    <strong>${t("overview.connection.authRequiredTitle")}</strong>
                    <div>${t("overview.connection.authRequiredBody")}</div>
                  </div>`
                : ""}
            </div>`
          : ""}
        <div class="login-gate__help">
          <div class="login-gate__help-title">${t("overview.connection.title")}</div>
          <ol class="login-gate__steps">
            <li>
              ${t("overview.connection.step1")}${renderConnectCommand("openclaw gateway run")}
            </li>
            <li>${t("overview.connection.step2")} ${renderConnectCommand("openclaw dashboard")}</li>
            <li>${t("overview.connection.step3")}</li>
          </ol>
          <div class="login-gate__docs">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target="_blank"
              rel="noreferrer"
              >${t("overview.connection.docsLink")}</a
            >
          </div>
        </div>
      </div>
    </div>
  `;
}
