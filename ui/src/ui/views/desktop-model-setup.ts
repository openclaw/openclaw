import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import {
  DESKTOP_MODEL_SETUP_PRESETS,
  type DesktopModelSetupForm,
  type DesktopModelSetupPreset,
} from "../controllers/desktop-model-setup.ts";
import { icons } from "../icons.ts";

function updateForm(state: AppViewState, patch: Partial<DesktopModelSetupForm>) {
  state.updateDesktopModelSetupForm?.(patch);
}

function renderWizardStepControl(state: AppViewState) {
  const step = state.desktopWizardStep;
  if (!step) {
    return nothing;
  }
  if (step.type === "text") {
    return html`
      <label class="field full">
        <span>${step.message ?? step.title ?? "Answer"}</span>
        <input
          type=${step.sensitive ? "password" : "text"}
          autocomplete="off"
          spellcheck="false"
          .value=${typeof state.desktopWizardAnswer === "string" ? state.desktopWizardAnswer : ""}
          placeholder=${step.placeholder ?? ""}
          @input=${(event: Event) =>
            state.updateDesktopSetupWizardAnswer?.((event.target as HTMLInputElement).value)}
        />
      </label>
    `;
  }
  if (step.type === "select") {
    return html`
      <label class="field full">
        <span>${step.message ?? step.title ?? "Choose an option"}</span>
        <select
          .value=${String(state.desktopWizardAnswer ?? step.options?.[0]?.value ?? "")}
          @change=${(event: Event) => {
            const selected = (event.target as HTMLSelectElement).value;
            const option = step.options?.find((entry) => String(entry.value) === selected);
            state.updateDesktopSetupWizardAnswer?.(option?.value ?? selected);
          }}
        >
          ${(step.options ?? []).map(
            (option) => html`
              <option
                value=${String(option.value)}
                ?selected=${option.value === state.desktopWizardAnswer}
              >
                ${option.label}
              </option>
            `,
          )}
        </select>
      </label>
    `;
  }
  if (step.type === "multiselect") {
    const selected = Array.isArray(state.desktopWizardAnswer) ? state.desktopWizardAnswer : [];
    return html`
      <div class="desktop-model-setup__checks">
        <div class="desktop-model-setup__status-summary">${step.message ?? step.title}</div>
        ${(step.options ?? []).map(
          (option) => html`
            <label class="desktop-model-setup__check">
              <input
                type="checkbox"
                .checked=${selected.some((value) => String(value) === String(option.value))}
                @change=${(event: Event) => {
                  const checked = (event.target as HTMLInputElement).checked;
                  const next = checked
                    ? [...selected, option.value]
                    : selected.filter((value) => String(value) !== String(option.value));
                  state.updateDesktopSetupWizardAnswer?.(next);
                }}
              />
              <span>${option.label}</span>
            </label>
          `,
        )}
      </div>
    `;
  }
  if (step.type === "confirm") {
    return html`
      <label class="desktop-model-setup__check">
        <input
          type="checkbox"
          .checked=${state.desktopWizardAnswer === true}
          @change=${(event: Event) =>
            state.updateDesktopSetupWizardAnswer?.((event.target as HTMLInputElement).checked)}
        />
        <span>${step.message ?? step.title ?? "Confirm"}</span>
      </label>
    `;
  }
  return html`
    <div class="desktop-model-setup__status-summary">
      ${step.message || step.title || step.type}
    </div>
  `;
}

export function renderDesktopModelSetup(state: AppViewState) {
  const form = state.desktopModelSetupForm;
  const preset =
    DESKTOP_MODEL_SETUP_PRESETS.find((entry) => entry.id === form.preset) ??
    DESKTOP_MODEL_SETUP_PRESETS[0];
  const checking = state.desktopModelSetupLoading || !state.desktopModelSetupChecked;
  const showBaseUrl = preset.requiresBaseUrl || form.baseUrl.trim();
  const canSubmit = !checking && !state.desktopModelSetupSaving;
  const permissionRows = state.desktopStatus?.permissions?.entries ?? [];
  const gatewayUrl = state.settings.gatewayUrl;
  const cliStatus = state.desktopCliStatus;
  const cliVersion = cliStatus?.version ?? null;
  const cliInstallSpec = cliStatus?.install_spec ?? cliStatus?.installSpec ?? "openclaw";
  const preferredCliManager = cliStatus?.preferred_manager ?? cliStatus?.preferredManager ?? null;

  return html`
    <div class="desktop-model-setup">
      <div class="desktop-model-setup__card">
        <div class="desktop-model-setup__header">
          <div class="desktop-model-setup__icon">${icons.settings}</div>
          <div>
            <div class="desktop-model-setup__title">${t("desktopModelSetup.title")}</div>
            <div class="desktop-model-setup__subtitle">${t("desktopModelSetup.subtitle")}</div>
          </div>
        </div>

        <div class="desktop-model-setup__status">
          <div class="desktop-model-setup__status-icon">${icons.settings}</div>
          <div>
            <div class="desktop-model-setup__status-title">Setup wizard</div>
            <div class="desktop-model-setup__status-summary">
              Use the Gateway-owned setup flow for provider auth, model choices, workspace, and
              plugin-owned onboarding.
            </div>
            ${state.desktopWizardError
              ? html`<div class="callout danger">${state.desktopWizardError}</div>`
              : nothing}
            ${state.desktopWizardDone
              ? html`<div class="callout success">Setup wizard completed.</div>`
              : nothing}
            ${state.desktopWizardStep
              ? html`
                  <div class="desktop-model-setup__wizard">
                    <div class="desktop-model-setup__status-title">
                      ${state.desktopWizardStep.title ?? state.desktopWizardStep.type}
                    </div>
                    ${renderWizardStepControl(state)}
                  </div>
                `
              : nothing}
            <div class="desktop-model-setup__actions">
              <button
                class="btn"
                type="button"
                ?disabled=${state.desktopWizardBusy}
                @click=${() => state.startDesktopSetupWizard?.()}
              >
                ${state.desktopWizardBusy ? icons.loader : icons.settings} Start wizard
              </button>
              ${state.desktopWizardSessionId
                ? html`
                    <button
                      class="btn primary"
                      type="button"
                      ?disabled=${state.desktopWizardBusy}
                      @click=${() => state.submitDesktopSetupWizard?.()}
                    >
                      ${icons.check} Continue
                    </button>
                    <button
                      class="btn"
                      type="button"
                      ?disabled=${state.desktopWizardBusy}
                      @click=${() => state.cancelDesktopSetupWizard?.()}
                    >
                      Cancel
                    </button>
                  `
                : nothing}
            </div>
          </div>
        </div>

        <div class="desktop-model-setup__status">
          <div class="desktop-model-setup__status-icon">${icons.terminal}</div>
          <div>
            <div class="desktop-model-setup__status-title">CLI helper</div>
            <div class="desktop-model-setup__status-summary">
              ${cliStatus?.installed
                ? html`Installed${cliVersion ? html`: ${cliVersion}` : nothing}.`
                : html`Optional command-line helper for terminal workflows.`}
              ${preferredCliManager
                ? html` Installer: ${preferredCliManager}; package: ${cliInstallSpec}.`
                : nothing}
            </div>
            ${state.desktopCliMessage
              ? html`
                  <div class="callout ${state.desktopCliMessage.kind}">
                    ${state.desktopCliMessage.text}
                  </div>
                `
              : nothing}
            <div class="desktop-model-setup__actions">
              <button
                class="btn"
                type="button"
                ?disabled=${state.desktopCliLoading}
                @click=${() => state.refreshDesktopCliStatus?.()}
              >
                ${state.desktopCliLoading ? icons.loader : icons.refresh} Check CLI
              </button>
              <button
                class="btn"
                type="button"
                ?disabled=${state.desktopCliInstalling || !preferredCliManager}
                @click=${() => state.installDesktopCliHelper?.()}
              >
                ${state.desktopCliInstalling ? icons.loader : icons.download} Install CLI
              </button>
            </div>
          </div>
        </div>

        <div class="desktop-model-setup__status">
          <div class="desktop-model-setup__status-icon">${icons.radio}</div>
          <div>
            <div class="desktop-model-setup__status-title">Gateway connection</div>
            <div class="desktop-model-setup__status-summary">
              Use the managed local Gateway, or connect this desktop app to another OpenClaw
              Gateway.
            </div>
            <div class="desktop-model-setup__actions">
              <button class="btn" type="button" @click=${() => state.startDesktopGateway?.()}>
                ${icons.monitor} Local Gateway
              </button>
            </div>
            <div class="desktop-model-setup__grid">
              <label class="field full">
                <span>Gateway URL</span>
                <input
                  autocomplete="off"
                  spellcheck="false"
                  .value=${gatewayUrl}
                  placeholder="ws://127.0.0.1:18789"
                  @input=${(event: Event) => {
                    state.applySettings?.({
                      ...state.settings,
                      gatewayUrl: (event.target as HTMLInputElement).value,
                    });
                  }}
                />
              </label>
              <label class="field">
                <span>Gateway token</span>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  .value=${state.settings.token}
                  placeholder="OPENCLAW_GATEWAY_TOKEN"
                  @input=${(event: Event) => {
                    state.applySettings?.({
                      ...state.settings,
                      token: (event.target as HTMLInputElement).value,
                    });
                  }}
                />
              </label>
              <label class="field">
                <span>Gateway password</span>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  .value=${state.password}
                  placeholder="Optional"
                  @input=${(event: Event) => {
                    state.password = (event.target as HTMLInputElement).value;
                  }}
                />
              </label>
            </div>
            <div class="desktop-model-setup__actions">
              <button class="btn" type="button" @click=${() => state.connect?.()}>
                ${icons.link} Connect
              </button>
            </div>
          </div>
        </div>

        <div class="desktop-model-setup__status">
          <div class="desktop-model-setup__status-icon">${icons.radio}</div>
          <div>
            <div class="desktop-model-setup__status-title">Desktop permissions</div>
            <div class="desktop-model-setup__status-summary">
              Notifications use the native desktop path. macOS shows live status where the system
              exposes a preflight check, and each row opens its settings panel when available.
            </div>
            <div class="desktop-model-setup__actions">
              <button
                class="btn"
                type="button"
                ?disabled=${state.desktopNotificationLoading}
                @click=${() => state.handleDesktopNotificationEnable?.()}
              >
                ${state.desktopNotificationLoading ? icons.loader : icons.check} Enable
                notifications
              </button>
              <button
                class="btn"
                type="button"
                ?disabled=${state.desktopNotificationLoading ||
                state.desktopNotificationPermission !== "granted"}
                @click=${() => state.handleDesktopNotificationTest?.()}
              >
                ${icons.send} Test
              </button>
            </div>
            ${permissionRows.length > 0
              ? html`
                  <div class="settings-list">
                    ${permissionRows.map(
                      (entry) => html`
                        <div class="settings-info-row">
                          <span class="settings-info-row__label">${entry.label}</span>
                          <span class="settings-info-row__value">${entry.status}</span>
                          <button
                            class="btn btn--sm"
                            type="button"
                            ?disabled=${!(entry.settings_url ?? entry.settingsUrl)}
                            @click=${() => state.openDesktopPermissionSettings?.(entry.id)}
                          >
                            Open
                          </button>
                        </div>
                      `,
                    )}
                  </div>
                `
              : nothing}
          </div>
        </div>

        ${checking
          ? html`
              <div class="desktop-model-setup__status">
                <span class="desktop-model-setup__spinner">${icons.loader}</span>
                <div>
                  <div class="desktop-model-setup__status-title">
                    ${t("desktopModelSetup.checkingTitle")}
                  </div>
                  <div class="desktop-model-setup__status-summary">
                    ${t("desktopModelSetup.checkingSummary")}
                  </div>
                </div>
              </div>
            `
          : html`
              <form
                class="desktop-model-setup__form"
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  void state.saveDesktopModelSetup?.();
                }}
              >
                <label class="field">
                  <span>${t("desktopModelSetup.provider")}</span>
                  <select
                    .value=${form.preset}
                    @change=${(event: Event) => {
                      updateForm(state, {
                        preset: (event.target as HTMLSelectElement)
                          .value as DesktopModelSetupPreset,
                      });
                    }}
                  >
                    ${repeat(
                      DESKTOP_MODEL_SETUP_PRESETS,
                      (entry) => entry.id,
                      (entry) => html`
                        <option value=${entry.id} ?selected=${entry.id === form.preset}>
                          ${t(`desktopModelSetup.presets.${entry.id}`)}
                        </option>
                      `,
                    )}
                  </select>
                </label>

                ${form.preset === "custom"
                  ? html`
                      <label class="field">
                        <span>${t("desktopModelSetup.providerId")}</span>
                        <input
                          autocomplete="off"
                          spellcheck="false"
                          .value=${form.providerId}
                          placeholder="local-openai"
                          @input=${(event: Event) =>
                            updateForm(state, {
                              providerId: (event.target as HTMLInputElement).value,
                            })}
                        />
                      </label>
                    `
                  : html`
                      <div class="desktop-model-setup__provider-lock">
                        <span>${t("desktopModelSetup.providerId")}</span>
                        <strong>${form.providerId}</strong>
                      </div>
                    `}

                <label class="field">
                  <span>${t("desktopModelSetup.modelId")}</span>
                  <input
                    autocomplete="off"
                    spellcheck="false"
                    .value=${form.modelId}
                    placeholder=${t("desktopModelSetup.modelPlaceholder")}
                    @input=${(event: Event) =>
                      updateForm(state, { modelId: (event.target as HTMLInputElement).value })}
                  />
                </label>

                <label class="field">
                  <span>${t("desktopModelSetup.displayName")}</span>
                  <input
                    autocomplete="off"
                    .value=${form.displayName}
                    placeholder=${form.modelId || t("desktopModelSetup.displayNamePlaceholder")}
                    @input=${(event: Event) =>
                      updateForm(state, {
                        displayName: (event.target as HTMLInputElement).value,
                      })}
                  />
                </label>

                ${showBaseUrl
                  ? html`
                      <label class="field full">
                        <span>${t("desktopModelSetup.baseUrl")}</span>
                        <input
                          autocomplete="off"
                          spellcheck="false"
                          .value=${form.baseUrl}
                          placeholder="http://127.0.0.1:1234/v1"
                          @input=${(event: Event) =>
                            updateForm(state, {
                              baseUrl: (event.target as HTMLInputElement).value,
                            })}
                        />
                      </label>
                    `
                  : nothing}

                <label class="field full">
                  <span>
                    ${preset.requiresApiKey
                      ? t("desktopModelSetup.apiKey")
                      : t("desktopModelSetup.apiKeyOptional")}
                  </span>
                  <input
                    type="password"
                    autocomplete="off"
                    spellcheck="false"
                    .value=${form.apiKey}
                    placeholder=${preset.requiresApiKey
                      ? t("desktopModelSetup.apiKeyPlaceholder")
                      : t("desktopModelSetup.apiKeyOptionalPlaceholder")}
                    @input=${(event: Event) =>
                      updateForm(state, { apiKey: (event.target as HTMLInputElement).value })}
                  />
                </label>

                ${state.desktopModelSetupError
                  ? html`
                      <div class="callout danger desktop-model-setup__error" role="alert">
                        <div class="login-gate__failure-title">
                          ${t("desktopModelSetup.errorTitle")}
                        </div>
                        <div class="login-gate__failure-summary">
                          ${state.desktopModelSetupError}
                        </div>
                      </div>
                    `
                  : nothing}

                <div class="desktop-model-setup__actions">
                  <button class="btn primary" type="submit" ?disabled=${!canSubmit}>
                    ${state.desktopModelSetupSaving ? icons.loader : icons.check}
                    ${state.desktopModelSetupSaving
                      ? t("desktopModelSetup.saving")
                      : t("desktopModelSetup.save")}
                  </button>
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${state.desktopModelSetupSaving}
                    @click=${() => state.openDesktopModelAdvancedSettings?.()}
                  >
                    ${icons.settings} ${t("desktopModelSetup.advanced")}
                  </button>
                </div>
              </form>
            `}
      </div>
    </div>
  `;
}
