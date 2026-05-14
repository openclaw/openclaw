import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";
import { normalizeBasePath } from "../navigation.ts";
import { agentLogoUrl } from "./agents-utils.ts";
import { renderConnectCommand } from "./connect-command.ts";

export function renderLoginGate(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const faviconSrc = agentLogoUrl(basePath);

  const trustPoints = [
    {
      icon: icons.check,
      title: "Local-first",
      text: "Keep the gateway on your machine and stay in control.",
    },
    {
      icon: icons.spark,
      title: "Fast access",
      text: "Clean layout, fewer distractions, quicker reconnects.",
    },
    {
      icon: icons.monitor,
      title: "Dashboard ready",
      text: "Jump straight into the control surface once connected.",
    },
  ];

  return html`
    <div class="login-gate">
      <div class="login-gate__ambient login-gate__ambient--one"></div>
      <div class="login-gate__ambient login-gate__ambient--two"></div>

      <div class="login-gate__card">
        <div class="login-gate__hero">
          <div class="login-gate__brand">
            <div class="login-gate__logo-wrap">
              <img class="login-gate__logo" src=${faviconSrc} alt="OpenClaw" />
            </div>
            <div class="login-gate__brand-copy">
              <div class="login-gate__badge pill">
                ${icons.spark}
                <span>Premium access</span>
              </div>
              <div class="login-gate__title">OpenClaw</div>
              <div class="login-gate__sub">${t("login.subtitle")}</div>
            </div>
          </div>

          <div class="login-gate__hero-copy">
            <div class="login-gate__eyebrow">Local-first. Fast. Secure.</div>
            <p class="login-gate__lede">
              Connect to your gateway through a polished entry point that feels intentional,
              modern, and on-brand.
            </p>
            <div class="login-gate__meta">
              <span class="pill"><strong>Encrypted</strong> token auth</span>
              <span class="pill"><strong>Instant</strong> reconnect</span>
              <span class="pill"><strong>Live</strong> dashboard</span>
            </div>
          </div>
        </div>

        <div class="login-gate__layout">
          <section class="login-gate__panel login-gate__panel--form">
            <div class="login-gate__panel-title">Sign in</div>
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
          </section>

          <aside class="login-gate__panel login-gate__panel--side">
            <div class="login-gate__panel-title">Why this feels premium</div>
            <div class="login-gate__trust-list">
              ${trustPoints.map(
                (item) => html`
                  <div class="login-gate__trust-item">
                    <div class="login-gate__trust-icon">${item.icon}</div>
                    <div>
                      <div class="login-gate__trust-title">${item.title}</div>
                      <div class="login-gate__trust-text">${item.text}</div>
                    </div>
                  </div>
                `,
              )}
            </div>

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
          </aside>
        </div>

        ${state.lastError
          ? html`<div class="callout danger login-gate__error" role="alert">
              <div>${state.lastError}</div>
            </div>`
          : ""}
      </div>
    </div>
  `;
}
