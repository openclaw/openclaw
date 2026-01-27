import { html, nothing } from "lit";

import { clampText } from "../format";
import { icon } from "../icons";
import { skeleton } from "../components/design-utils";
import type { SkillStatusEntry, SkillStatusReport } from "../types";
import type { SkillMessageMap } from "../controllers/skills";

export type SkillsProps = {
  loading: boolean;
  report: SkillStatusReport | null;
  error: string | null;
  filter: string;
  edits: Record<string, string>;
  busyKey: string | null;
  messages: SkillMessageMap;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
};

function renderSkillsSkeleton() {
  return html`
    ${[1, 2, 3, 4, 5, 6].map(
      (i) => html`
        <div class="skill-card skill-card--modern" style="animation: view-fade-in 0.2s ease-out; animation-delay: ${i * 50}ms; animation-fill-mode: backwards;">
          <div class="skill-card__header">
            <div class="skill-card__icon">${skeleton({ width: "40px", height: "40px", rounded: true })}</div>
            <div class="skill-card__info" style="flex: 1;">
              ${skeleton({ width: "120px", height: "16px" })}
              <div style="margin-top: 8px;">${skeleton({ width: "180px", height: "12px" })}</div>
            </div>
          </div>
          <div class="skill-card__badges" style="margin-top: 12px; display: flex; gap: 6px;">
            ${skeleton({ width: "60px", height: "20px" })}
            ${skeleton({ width: "70px", height: "20px" })}
          </div>
        </div>
      `,
    )}
  `;
}

export function renderSkills(props: SkillsProps) {
  const skills = props.report?.skills ?? [];
  const filter = props.filter.trim().toLowerCase();
  const filtered = filter
    ? skills.filter((skill) =>
        [skill.name, skill.description, skill.source]
          .join(" ")
          .toLowerCase()
          .includes(filter),
      )
    : skills;

  const eligibleCount = filtered.filter((s) => s.eligible).length;
  const blockedCount = filtered.length - eligibleCount;

  return html`
    <section class="card">
      <!-- Modern Table Header Card -->
      <div class="table-header-card">
        <div class="table-header-card__left">
          <div class="table-header-card__icon">
            ${icon("zap", { size: 22 })}
          </div>
          <div class="table-header-card__info">
            <div class="table-header-card__title">Skills</div>
            <div class="table-header-card__subtitle">${skills.length} total skill${skills.length !== 1 ? "s" : ""}</div>
          </div>
        </div>
        <div class="table-header-card__right">
          <button class="btn btn--secondary" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${icon("refresh-cw", { size: 14 })}
            <span>${props.loading ? "Loading..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      <!-- Modern Filter Bar -->
      <div class="table-filters--modern">
        <div class="field--modern table-filters__search" style="flex: 1; max-width: 400px;">
          <label class="field__label">Search</label>
          <div class="field__input-wrapper ${props.filter ? "field__input-wrapper--has-clear" : ""}">
            <span class="field__icon">${icon("search", { size: 14 })}</span>
            <input
              class="field__input"
              type="text"
              placeholder="Filter by name, description, or source..."
              .value=${props.filter}
              @input=${(e: Event) =>
                props.onFilterChange((e.target as HTMLInputElement).value)}
            />
            ${props.filter
              ? html`<button
                  class="field__clear"
                  type="button"
                  title="Clear filter"
                  aria-label="Clear filter"
                  @click=${() => props.onFilterChange("")}
                >
                  ${icon("x", { size: 14 })}
                </button>`
              : nothing}
          </div>
        </div>
        <div style="display: flex; gap: 10px; align-items: center;">
          <span class="badge ${eligibleCount > 0 ? "badge--ok badge--animated" : "badge--muted"}">
            ${icon("check", { size: 10 })}
            <span>${eligibleCount} eligible</span>
          </span>
          ${blockedCount > 0
            ? html`<span class="badge badge--warn badge--animated">
                ${icon("alert-triangle", { size: 10 })}
                <span>${blockedCount} blocked</span>
              </span>`
            : nothing}
        </div>
      </div>

      ${props.error
        ? html`
          <div class="callout--danger" style="margin-top: 16px;">
            <div class="callout__icon">${icon("alert-circle", { size: 18 })}</div>
            <div class="callout__content">${props.error}</div>
          </div>
        `
        : nothing}

      ${props.loading && !props.report
        ? html`
            <div class="skills-grid" aria-busy="true">
              ${renderSkillsSkeleton()}
            </div>
          `
        : filtered.length === 0
          ? html`
            <div class="data-table__empty">
              <div class="data-table__empty-icon">${icon("zap", { size: 32 })}</div>
              <div class="data-table__empty-title">No skills found</div>
              <div class="data-table__empty-desc">
                ${filter ? "Try adjusting your search filter" : "Skills extend what your gateway can do. Install skills via the CLI to get started."}
              </div>
              ${filter
                ? html`<button class="btn btn--sm" style="margin-top: 12px;" @click=${() => props.onFilterChange("")}>
                    ${icon("x", { size: 14 })}
                    <span>Clear filter</span>
                  </button>`
                : html`<button class="btn btn--sm" style="margin-top: 12px;" ?disabled=${props.loading} @click=${props.onRefresh}>
                    ${icon("refresh-cw", { size: 14 })}
                    <span>Refresh</span>
                  </button>`}
            </div>
          `
          : html`
              <div class="skills-grid">
                ${filtered.map((skill) => renderSkill(skill, props))}
              </div>
            `}
    </section>
  `;
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const apiKey = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const canInstall =
    skill.install.length > 0 && skill.missing.bins.length > 0;
  const missing = [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
  const reasons: string[] = [];
  if (skill.disabled) reasons.push("disabled");
  if (skill.blockedByAllowlist) reasons.push("blocked by allowlist");

  return html`
    <div class="skill-card skill-card--modern ${skill.eligible ? "" : "skill-card--blocked"} ${skill.disabled ? "skill-card--disabled" : ""}">
      <div class="skill-card__status-indicator ${skill.eligible && !skill.disabled ? "skill-card__status-indicator--active" : skill.disabled ? "skill-card__status-indicator--disabled" : ""}"></div>
      <div class="skill-card__header">
        <div class="skill-card__icon ${!skill.emoji ? "skill-card__icon--zap" : ""}">
          ${skill.emoji ? skill.emoji : icon("zap", { size: 20 })}
        </div>
        <div class="skill-card__info">
          <div class="skill-card__name">${skill.name}</div>
          <div class="skill-card__desc">${clampText(skill.description, 120)}</div>
        </div>
      </div>

      <div class="skill-card__badges">
        <span class="badge badge--info">${skill.source}</span>
        <span class="badge ${skill.eligible ? "badge--ok badge--animated" : "badge--warn badge--animated"}">
          ${icon(skill.eligible ? "check" : "alert-triangle", { size: 10 })}
          <span>${skill.eligible ? "eligible" : "blocked"}</span>
        </span>
        ${skill.disabled
          ? html`<span class="badge badge--danger badge--animated">
              ${icon("pause", { size: 10 })}
              <span>disabled</span>
            </span>`
          : nothing}
      </div>

      ${missing.length > 0
        ? html`
          <div class="skill-card__missing">
            ${icon("alert-circle", { size: 12 })}
            <span style="margin-left: 6px;">Missing: ${missing.join(", ")}</span>
          </div>
        `
        : nothing}

      ${reasons.length > 0 && !skill.disabled
        ? html`
          <div class="muted" style="margin-top: 8px; font-size: 11px;">
            ${icon("info", { size: 12 })}
            <span style="margin-left: 4px;">Reason: ${reasons.join(", ")}</span>
          </div>
        `
        : nothing}

      <div class="skill-card__actions row-actions row-actions--modern">
        <button
          class="row-actions__btn ${skill.disabled ? "row-actions__btn--primary" : ""}"
          title=${skill.disabled ? "Enable skill" : "Disable skill"}
          aria-label=${skill.disabled ? "Enable skill" : "Disable skill"}
          ?disabled=${busy}
          @click=${() => props.onToggle(skill.skillKey, skill.disabled)}
        >
          ${icon(skill.disabled ? "play" : "pause", { size: 14 })}
        </button>
        ${canInstall
          ? html`
            <button
              class="row-actions__btn row-actions__btn--primary"
              title=${skill.install[0].label}
              aria-label=${skill.install[0].label}
              ?disabled=${busy}
              @click=${() =>
                props.onInstall(skill.skillKey, skill.name, skill.install[0].id)}
            >
              ${icon("plus", { size: 14 })}
            </button>
          `
          : nothing}
      </div>

      ${message
        ? html`
          <div
            class="callout ${message.kind === "error" ? "callout--danger" : "callout--info"}"
            style="margin-top: 12px; padding: 10px 12px; font-size: 12px;"
          >
            ${icon(message.kind === "error" ? "alert-circle" : "check", { size: 14 })}
            <span style="margin-left: 8px;">${message.message}</span>
          </div>
        `
        : nothing}

      ${skill.primaryEnv
        ? html`
          <div class="skill-card__api-key" style="margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);">
            <div class="api-status ${apiKey || skill.primaryEnv ? "api-status--configured" : "api-status--missing"}" style="margin-bottom: 8px;">
              ${icon(apiKey ? "check" : "alert-triangle", { size: 12 })}
              <span>API Key: ${apiKey ? "configured" : "not set"}</span>
            </div>
            <div class="field" style="margin-bottom: 10px;">
              <span>API key for ${skill.primaryEnv}</span>
              <input
                type="password"
                .value=${apiKey}
                placeholder="Enter API key..."
                @input=${(e: Event) =>
                  props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
              />
            </div>
            <button
              class="btn btn--sm btn--primary"
              ?disabled=${busy || !apiKey}
              @click=${() => props.onSaveKey(skill.skillKey)}
            >
              ${icon("check", { size: 12 })}
              <span>Save key</span>
            </button>
          </div>
        `
        : nothing}
    </div>
  `;
}
