import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { renderThemeToggle } from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import { normalizeBasePath } from "../navigation.ts";

export function renderLoginGate(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const faviconSrc = basePath ? `${basePath}/favicon.svg` : "/favicon.svg";

  return html`
    <div class="login-gate">
      <div class="login-gate__theme">${renderThemeToggle(state)}</div>
      <div class="login-gate__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${faviconSrc} alt="OpenClaw" />
          <div class="login-gate__title">OpenClaw</div>
          <div class="login-gate__sub">${t("login.subtitle")}</div>
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
            <span>${t("overview.access.password")}</span>
            <input
              type="password"
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
          </label>
          <button
            class="btn primary login-gate__connect"
            @click=${() => state.connect()}
          >
            ${t("common.connect")}
          </button>
        </div>
        ${
          state.lastError
            ? html`<div class="callout danger" style="margin-top: 14px;">
                <div>${state.lastError}</div>
              </div>`
            : ""
        }
        <div class="login-gate__help">
          <div style="font-weight: 600; font-size: 12px; margin-bottom: 8px;">${t("overview.connection.title")}</div>
          <ol class="muted" style="margin: 0; padding-left: 16px; font-size: 12px; line-height: 1.7;">
            <li>${t("overview.connection.step1")}
              <div class="mono" style="font-size: 11px; margin: 2px 0 4px;">openclaw gateway run</div>
            </li>
            <li>${t("overview.connection.step2")}
              <div class="mono" style="font-size: 11px; margin: 2px 0 4px;">openclaw dashboard --no-open</div>
            </li>
            <li>${t("overview.connection.step3")}</li>
          </ol>
          <div class="muted" style="font-size: 11px; margin-top: 8px;">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target="_blank"
              rel="noreferrer"
            >${t("overview.connection.docsLink")}</a>
          </div>
        </div>
      </div>
    </div>
  `;
}
