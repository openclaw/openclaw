import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  MemoryAuditSettingsDraft,
  MemoryAuditSettingsErrors,
  MemoryAuditSuggestion,
  MemoryAuditSuggestions,
  MemoryAuditTab,
} from "../controllers/memory-audit.ts";
import {
  memoryAuditSettingsDirty,
  validateMemoryAuditSettings,
} from "../controllers/memory-audit.ts";
import { icons } from "../icons.ts";

export type MemoryAuditSettingsSuggestions = {
  agents: string[];
  sessions: string[];
  models: string[];
  timezones: string[];
  channels: string[];
  channelLabels: Record<string, string>;
  deliveryTargets: string[];
  accounts: string[];
};

export type MemoryAuditProps = {
  activeTab: MemoryAuditTab;
  loading: boolean;
  error: string | null;
  actionId: string | null;
  actionMessage: { kind: "success" | "error"; text: string } | null;
  suggestions: MemoryAuditSuggestions | null;
  settingsLoading: boolean;
  settingsSaving: boolean;
  settingsError: string | null;
  settingsMessage: { kind: "success" | "error"; text: string } | null;
  settingsDraft: MemoryAuditSettingsDraft;
  settingsOriginal: MemoryAuditSettingsDraft;
  settingsSuggestions: MemoryAuditSettingsSuggestions;
  onTabChange: (tab: MemoryAuditTab) => void;
  onSettingsChange: (patch: Partial<MemoryAuditSettingsDraft>) => void;
  onSettingsSave: () => void;
  onSettingsReset: () => void;
  onRefresh: () => void;
  onApply: (suggestion: MemoryAuditSuggestion) => void;
  onReject: (suggestion: MemoryAuditSuggestion) => void;
};

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function formatAction(action: MemoryAuditSuggestion["action"]): string {
  return t(`memoryAudit.action.${action}`);
}

function formatStatus(status: MemoryAuditSuggestion["status"]): string {
  return t(`memoryAudit.status.${status}`);
}

function formatKind(kind: MemoryAuditSuggestion["target"]["kind"]): string {
  return t(`memoryAudit.kind.${kind}`);
}

function sourceLabel(suggestion: MemoryAuditSuggestion): string | null {
  const source = suggestion.source;
  if (!source) {
    return null;
  }
  return `${source.path}:${source.startLine}-${source.endLine}`;
}

function renderSuggestionList(id: string, options: string[]) {
  return html`<datalist id=${id}>
    ${options.map((option) => html`<option value=${option}></option>`)}
  </datalist>`;
}

function renderMetric(label: string, value: number, tone: string) {
  return html`
    <div class="memory-audit__metric memory-audit__metric--${tone}">
      <span class="memory-audit__metric-value">${value}</span>
      <span class="memory-audit__metric-label">${label}</span>
    </div>
  `;
}

function renderSummary(summary: MemoryAuditSuggestions | null) {
  const total = summary?.total ?? 0;
  return html`
    <div class="memory-audit__summary" aria-label=${t("memoryAudit.summary.label")}>
      ${renderMetric(t("memoryAudit.summary.total"), total, "total")}
      ${renderMetric(t("memoryAudit.summary.pending"), summary?.pending ?? 0, "pending")}
      ${renderMetric(t("memoryAudit.summary.applied"), summary?.applied ?? 0, "applied")}
      ${renderMetric(t("memoryAudit.summary.rejected"), summary?.rejected ?? 0, "rejected")}
      ${renderMetric(t("memoryAudit.summary.conflict"), summary?.conflict ?? 0, "conflict")}
    </div>
  `;
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
    ? event.target.value
    : "";
}

function inputChecked(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false;
}

function parseSimpleDailyCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") {
    return "";
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23
  ) {
    return "";
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseSimpleWeeklyCron(cron: string): { day: string; time: string } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts[2] !== "*" || parts[3] !== "*") {
    return { day: "", time: "" };
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  const day = Number(parts[4]);
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(day) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23 ||
    day < 0 ||
    day > 6
  ) {
    return { day: "", time: "" };
  }
  return {
    day: String(day),
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function cronFromTime(time: string, day?: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return day === undefined ? `${minute} ${hour} * * *` : `${minute} ${hour} * * ${day}`;
}

function renderFieldError(errors: MemoryAuditSettingsErrors, key: keyof MemoryAuditSettingsErrors) {
  const error = errors[key];
  return error ? html`<div class="memory-audit-settings__error">${t(error)}</div>` : nothing;
}

function renderSettings(props: MemoryAuditProps) {
  const draft = props.settingsDraft;
  const errors = validateMemoryAuditSettings(draft);
  const dirty = memoryAuditSettingsDirty({
    memoryAuditSettingsDraft: draft,
    memoryAuditSettingsOriginal: props.settingsOriginal,
  });
  const canSave =
    dirty && !props.settingsLoading && !props.settingsSaving && Object.keys(errors).length === 0;
  const dailyTime = parseSimpleDailyCron(draft.dailyCron);
  const weekly = parseSimpleWeeklyCron(draft.weeklyCron);
  const updateDailyTime = (time: string) => {
    const cron = cronFromTime(time);
    props.onSettingsChange(cron ? { dailyCron: cron } : {});
  };
  const updateWeeklyCron = (day: string, time: string) => {
    const cron = day !== "" ? cronFromTime(time, day) : null;
    props.onSettingsChange(cron ? { weeklyCron: cron } : {});
  };

  return html`
    <div class="memory-audit-settings">
      ${props.settingsMessage
        ? html`<div
            class="callout ${props.settingsMessage.kind === "error" ? "danger" : "success"}"
            role="status"
          >
            ${props.settingsMessage.text}
          </div>`
        : nothing}
      ${props.settingsError
        ? html`<div class="callout danger" role="alert">${props.settingsError}</div>`
        : nothing}

      <section class="memory-audit-settings__section">
        <div class="memory-audit-settings__section-title">${t("memoryAudit.settings.audit")}</div>
        <label class="memory-audit-settings__checkbox">
          <input
            type="checkbox"
            .checked=${draft.enabled}
            @change=${(event: Event) => props.onSettingsChange({ enabled: inputChecked(event) })}
          />
          <span>${t("memoryAudit.settings.enabled")}</span>
        </label>
      </section>

      <section class="memory-audit-settings__section">
        <div class="memory-audit-settings__section-title">
          ${t("memoryAudit.settings.execution")}
        </div>
        <div class="memory-audit-settings__grid">
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.agent")}</span>
            <input
              .value=${draft.agentId}
              list="memory-audit-agent-suggestions"
              placeholder=${t("memoryAudit.settings.defaultAgent")}
              @input=${(event: Event) => props.onSettingsChange({ agentId: inputValue(event) })}
            />
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.sessionTarget")}</span>
            <input
              .value=${draft.sessionTarget}
              list="memory-audit-session-suggestions"
              @input=${(event: Event) =>
                props.onSettingsChange({ sessionTarget: inputValue(event) })}
            />
            ${renderFieldError(errors, "sessionTarget")}
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.model")}</span>
            <input
              .value=${draft.model}
              list="memory-audit-model-suggestions"
              placeholder=${t("memoryAudit.settings.defaultModel")}
              @input=${(event: Event) => props.onSettingsChange({ model: inputValue(event) })}
            />
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.timezone")}</span>
            <input
              .value=${draft.timezone}
              list="memory-audit-timezone-suggestions"
              placeholder=${t("memoryAudit.settings.timezonePlaceholder")}
              @input=${(event: Event) => props.onSettingsChange({ timezone: inputValue(event) })}
            />
          </label>
        </div>
      </section>

      <section class="memory-audit-settings__section">
        <div class="memory-audit-settings__section-title">
          ${t("memoryAudit.settings.schedule")}
        </div>
        <div class="memory-audit-settings__schedule">
          <label class="memory-audit-settings__checkbox">
            <input
              type="checkbox"
              .checked=${draft.dailyEnabled}
              @change=${(event: Event) =>
                props.onSettingsChange({ dailyEnabled: inputChecked(event) })}
            />
            <span>${t("memoryAudit.settings.dailyEnabled")}</span>
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.dailyTime")}</span>
            <input
              type="time"
              .value=${dailyTime}
              @change=${(event: Event) => updateDailyTime(inputValue(event))}
            />
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.dailyCron")}</span>
            <input
              .value=${draft.dailyCron}
              @input=${(event: Event) => props.onSettingsChange({ dailyCron: inputValue(event) })}
            />
            ${renderFieldError(errors, "dailyCron")}
          </label>

          <label class="memory-audit-settings__checkbox">
            <input
              type="checkbox"
              .checked=${draft.weeklyEnabled}
              @change=${(event: Event) =>
                props.onSettingsChange({ weeklyEnabled: inputChecked(event) })}
            />
            <span>${t("memoryAudit.settings.weeklyEnabled")}</span>
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.weeklyDay")}</span>
            <select
              .value=${weekly.day}
              @change=${(event: Event) => updateWeeklyCron(inputValue(event), weekly.time)}
            >
              <option value="">${t("memoryAudit.settings.custom")}</option>
              <option value="0">${t("memoryAudit.weekday.0")}</option>
              <option value="1">${t("memoryAudit.weekday.1")}</option>
              <option value="2">${t("memoryAudit.weekday.2")}</option>
              <option value="3">${t("memoryAudit.weekday.3")}</option>
              <option value="4">${t("memoryAudit.weekday.4")}</option>
              <option value="5">${t("memoryAudit.weekday.5")}</option>
              <option value="6">${t("memoryAudit.weekday.6")}</option>
            </select>
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.weeklyTime")}</span>
            <input
              type="time"
              .value=${weekly.time}
              @change=${(event: Event) => updateWeeklyCron(weekly.day || "0", inputValue(event))}
            />
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.weeklyCron")}</span>
            <input
              .value=${draft.weeklyCron}
              @input=${(event: Event) => props.onSettingsChange({ weeklyCron: inputValue(event) })}
            />
            ${renderFieldError(errors, "weeklyCron")}
          </label>
        </div>
      </section>

      <section class="memory-audit-settings__section">
        <div class="memory-audit-settings__section-title">
          ${t("memoryAudit.settings.delivery")}
        </div>
        <div class="memory-audit-settings__grid">
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.deliveryMode")}</span>
            <select
              .value=${draft.deliveryMode}
              @change=${(event: Event) =>
                props.onSettingsChange({
                  deliveryMode: inputValue(event) as MemoryAuditSettingsDraft["deliveryMode"],
                })}
            >
              <option value="none">${t("memoryAudit.delivery.none")}</option>
              <option value="announce">${t("memoryAudit.delivery.announce")}</option>
              <option value="webhook">${t("memoryAudit.delivery.webhook")}</option>
            </select>
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.channel")}</span>
            <select
              .value=${draft.deliveryChannel}
              ?disabled=${draft.deliveryMode === "none"}
              @change=${(event: Event) =>
                props.onSettingsChange({ deliveryChannel: inputValue(event) })}
            >
              <option value="">${t("memoryAudit.settings.channelDefault")}</option>
              ${props.settingsSuggestions.channels.map(
                (channel) => html`<option value=${channel}>
                  ${props.settingsSuggestions.channelLabels[channel] ?? channel}
                </option>`,
              )}
            </select>
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.deliveryTo")}</span>
            <input
              .value=${draft.deliveryTo}
              list="memory-audit-delivery-target-suggestions"
              ?disabled=${draft.deliveryMode === "none"}
              @input=${(event: Event) => props.onSettingsChange({ deliveryTo: inputValue(event) })}
            />
            ${renderFieldError(errors, "deliveryTo")}
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.accountId")}</span>
            <input
              .value=${draft.deliveryAccountId}
              list="memory-audit-account-suggestions"
              ?disabled=${draft.deliveryMode === "none"}
              @input=${(event: Event) =>
                props.onSettingsChange({ deliveryAccountId: inputValue(event) })}
            />
          </label>
          <label class="memory-audit-settings__field">
            <span>${t("memoryAudit.settings.threadId")}</span>
            <input
              .value=${draft.deliveryThreadId}
              ?disabled=${draft.deliveryMode === "none"}
              @input=${(event: Event) =>
                props.onSettingsChange({ deliveryThreadId: inputValue(event) })}
            />
          </label>
        </div>
      </section>

      <div class="memory-audit-settings__footer">
        <div class="memory-audit-settings__restart-note">
          ${t("memoryAudit.settings.restartNote")}
        </div>
        <div class="memory-audit-settings__actions">
          <button
            class="btn btn--sm btn--subtle"
            ?disabled=${props.settingsLoading || props.settingsSaving || !dirty}
            @click=${props.onSettingsReset}
          >
            ${t("common.reset")}
          </button>
          <button
            class="btn btn--sm btn--primary"
            ?disabled=${!canSave}
            @click=${props.onSettingsSave}
          >
            ${props.settingsSaving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderSuggestion(props: MemoryAuditProps, suggestion: MemoryAuditSuggestion) {
  const pending = suggestion.status === "pending";
  const busy = props.actionId === suggestion.id;
  const disabled = props.loading || !pending || props.actionId !== null;
  const source = sourceLabel(suggestion);
  return html`
    <article class="memory-audit-item" data-suggestion-id=${suggestion.id}>
      <header class="memory-audit-item__header">
        <div class="memory-audit-item__title">
          <span class="memory-audit-item__action">${formatAction(suggestion.action)}</span>
          <span class="memory-audit-item__path">${suggestion.target.path}</span>
        </div>
        <div class="memory-audit-item__badges">
          <span class="memory-audit-badge memory-audit-badge--${suggestion.status}">
            ${formatStatus(suggestion.status)}
          </span>
          <span class="memory-audit-badge">${formatPercent(suggestion.confidence)}</span>
        </div>
      </header>

      <div class="memory-audit-item__meta">
        <span>${formatKind(suggestion.target.kind)}</span>
        ${suggestion.target.agentId ? html`<span>${suggestion.target.agentId}</span>` : nothing}
        ${source ? html`<span>${source}</span>` : nothing}
      </div>

      <p class="memory-audit-item__rationale">${suggestion.rationale}</p>
      <pre class="memory-audit-item__text">${suggestion.text}</pre>
      ${suggestion.conflict
        ? html`<div class="memory-audit-item__conflict" role="alert">${suggestion.conflict}</div>`
        : nothing}

      <footer class="memory-audit-item__actions">
        <button
          class="btn btn--sm btn--primary"
          ?disabled=${disabled}
          @click=${() => props.onApply(suggestion)}
        >
          ${icons.check}<span
            >${busy ? t("memoryAudit.actions.working") : t("memoryAudit.actions.apply")}</span
          >
        </button>
        <button
          class="btn btn--sm btn--subtle"
          ?disabled=${disabled}
          @click=${() => props.onReject(suggestion)}
        >
          ${icons.x}<span>${t("memoryAudit.actions.reject")}</span>
        </button>
      </footer>
    </article>
  `;
}

function renderReviewQueue(props: MemoryAuditProps) {
  const suggestions = props.suggestions?.suggestions ?? [];
  return html`
    <div class="memory-audit-review">
      <div class="memory-audit-toolbar">
        <div class="memory-audit-toolbar__copy">
          <div class="memory-audit-toolbar__title">${t("memoryAudit.review.title")}</div>
          <div class="memory-audit-toolbar__subtitle">${t("memoryAudit.review.subtitle")}</div>
        </div>
        <button
          class="btn btn--sm btn--subtle"
          ?disabled=${props.loading}
          @click=${props.onRefresh}
        >
          ${icons.refresh}<span
            >${props.loading ? t("common.refreshing") : t("common.refresh")}</span
          >
        </button>
      </div>

      ${renderSummary(props.suggestions)}
      ${props.actionMessage
        ? html`<div
            class="callout ${props.actionMessage.kind === "error" ? "danger" : "success"}"
            role="status"
          >
            ${props.actionMessage.text}
          </div>`
        : nothing}
      ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
      ${props.loading && suggestions.length === 0
        ? html`<div class="memory-audit-empty">${t("memoryAudit.review.loading")}</div>`
        : suggestions.length === 0
          ? html`<div class="memory-audit-empty">
              <div class="memory-audit-empty__title">${t("memoryAudit.review.emptyTitle")}</div>
              <div class="memory-audit-empty__body">${t("memoryAudit.review.emptyBody")}</div>
            </div>`
          : html`<div class="memory-audit-list">
              ${suggestions.map((suggestion) => renderSuggestion(props, suggestion))}
            </div>`}
    </div>
  `;
}

export function renderMemoryAudit(props: MemoryAuditProps) {
  return html`
    <section class="memory-audit-page">
      ${renderSuggestionList("memory-audit-agent-suggestions", props.settingsSuggestions.agents)}
      ${renderSuggestionList(
        "memory-audit-session-suggestions",
        props.settingsSuggestions.sessions,
      )}
      ${renderSuggestionList("memory-audit-model-suggestions", props.settingsSuggestions.models)}
      ${renderSuggestionList(
        "memory-audit-timezone-suggestions",
        props.settingsSuggestions.timezones,
      )}
      ${renderSuggestionList(
        "memory-audit-delivery-target-suggestions",
        props.settingsSuggestions.deliveryTargets,
      )}
      ${renderSuggestionList(
        "memory-audit-account-suggestions",
        props.settingsSuggestions.accounts,
      )}
      <div class="memory-audit-tabs" role="tablist" aria-label=${t("memoryAudit.tabs.label")}>
        <button
          class="memory-audit-tab ${props.activeTab === "settings" ? "is-active" : ""}"
          role="tab"
          aria-selected=${props.activeTab === "settings"}
          @click=${() => props.onTabChange("settings")}
        >
          ${t("memoryAudit.tabs.settings")}
        </button>
        <button
          class="memory-audit-tab ${props.activeTab === "review" ? "is-active" : ""}"
          role="tab"
          aria-selected=${props.activeTab === "review"}
          @click=${() => props.onTabChange("review")}
        >
          ${t("memoryAudit.tabs.review")}
        </button>
      </div>
      ${props.activeTab === "settings" ? renderSettings(props) : renderReviewQueue(props)}
    </section>
  `;
}
