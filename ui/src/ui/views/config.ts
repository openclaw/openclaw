import { html, nothing } from "lit";
import type { ConfigUiHints } from "../types";
import { analyzeConfigSchema, renderConfigForm } from "./config-form";

export type ConfigProps = {
  raw: string;
  valid: boolean | null;
  issues: unknown[];
  loading: boolean;
  saving: boolean;
  applying: boolean;
  updating: boolean;
  connected: boolean;
  schema: unknown | null;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: "form" | "raw";
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  searchQuery: string;
  activeSection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: "form" | "raw") => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onSearchChange: (query: string) => void;
  onSectionChange: (section: string | null) => void;
  onReload: () => void;
  onSave: () => void;
  onApply: () => void;
  onUpdate: () => void;
};

// Section definitions with icons
const SECTIONS: Array<{ key: string; label: string; icon: string }> = [
  { key: "env", label: "Environment", icon: "🔧" },
  { key: "update", label: "Updates", icon: "📦" },
  { key: "agents", label: "Agents", icon: "🤖" },
  { key: "auth", label: "Authentication", icon: "🔐" },
  { key: "channels", label: "Channels", icon: "💬" },
  { key: "messages", label: "Messages", icon: "📨" },
  { key: "commands", label: "Commands", icon: "⌨️" },
  { key: "hooks", label: "Hooks", icon: "🪝" },
  { key: "skills", label: "Skills", icon: "✨" },
  { key: "tools", label: "Tools", icon: "🛠️" },
  { key: "gateway", label: "Gateway", icon: "🌐" },
  { key: "wizard", label: "Setup Wizard", icon: "🧙" },
];

function computeDiff(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null
): Array<{ path: string; from: unknown; to: unknown }> {
  if (!original || !current) return [];
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];
  
  function compare(orig: unknown, curr: unknown, path: string) {
    if (orig === curr) return;
    if (typeof orig !== typeof curr) {
      changes.push({ path, from: orig, to: curr });
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      if (orig !== curr) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    if (Array.isArray(orig) && Array.isArray(curr)) {
      if (JSON.stringify(orig) !== JSON.stringify(curr)) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], path ? `${path}.${key}` : key);
    }
  }
  
  compare(original, current, "");
  return changes;
}

function truncateValue(value: unknown, maxLen = 40): string {
  const str = JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

export function renderConfig(props: ConfigProps) {
  const validity =
    props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const analysis = analyzeConfigSchema(props.schema);
  const formUnsafe = analysis.schema
    ? analysis.unsupportedPaths.length > 0
    : false;
  const canSaveForm =
    Boolean(props.formValue) && !props.loading && !formUnsafe;
  const canSave =
    props.connected &&
    !props.saving &&
    (props.formMode === "raw" ? true : canSaveForm);
  const canApply =
    props.connected &&
    !props.applying &&
    !props.updating &&
    (props.formMode === "raw" ? true : canSaveForm);
  const canUpdate = props.connected && !props.applying && !props.updating;

  // Get available sections from schema
  const schemaProps = analysis.schema?.properties ?? {};
  const availableSections = SECTIONS.filter(s => s.key in schemaProps);
  
  // Add any sections in schema but not in our list
  const knownKeys = new Set(SECTIONS.map(s => s.key));
  const extraSections = Object.keys(schemaProps)
    .filter(k => !knownKeys.has(k))
    .map(k => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1), icon: "📄" }));
  
  const allSections = [...availableSections, ...extraSections];
  
  // Compute diff for showing changes
  const diff = props.formMode === "form" 
    ? computeDiff(props.originalValue, props.formValue)
    : [];
  const hasChanges = diff.length > 0;

  return html`
    <div class="config-layout">
      <!-- Sidebar -->
      <aside class="config-sidebar">
        <div class="config-sidebar__header">
          <div class="config-sidebar__title">Settings</div>
          <span class="pill pill--sm ${validity === "valid" ? "pill--ok" : validity === "invalid" ? "pill--danger" : ""}">${validity}</span>
        </div>
        
        <!-- Search -->
        <div class="config-search">
          <svg class="config-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="M21 21l-4.35-4.35"></path>
          </svg>
          <input
            type="text"
            class="config-search__input"
            placeholder="Search settings..."
            .value=${props.searchQuery}
            @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
          />
          ${props.searchQuery ? html`
            <button 
              class="config-search__clear"
              @click=${() => props.onSearchChange("")}
            >×</button>
          ` : nothing}
        </div>
        
        <!-- Section nav -->
        <nav class="config-nav">
          <button
            class="config-nav__item ${props.activeSection === null ? "active" : ""}"
            @click=${() => props.onSectionChange(null)}
          >
            <span class="config-nav__icon">📋</span>
            <span class="config-nav__label">All Settings</span>
          </button>
          ${allSections.map(section => html`
            <button
              class="config-nav__item ${props.activeSection === section.key ? "active" : ""}"
              @click=${() => props.onSectionChange(section.key)}
            >
              <span class="config-nav__icon">${section.icon}</span>
              <span class="config-nav__label">${section.label}</span>
            </button>
          `)}
        </nav>
        
        <!-- Mode toggle at bottom -->
        <div class="config-sidebar__footer">
          <div class="config-mode-toggle">
            <button
              class="config-mode-toggle__btn ${props.formMode === "form" ? "active" : ""}"
              ?disabled=${props.schemaLoading || !props.schema}
              @click=${() => props.onFormModeChange("form")}
            >
              Form
            </button>
            <button
              class="config-mode-toggle__btn ${props.formMode === "raw" ? "active" : ""}"
              @click=${() => props.onFormModeChange("raw")}
            >
              Raw
            </button>
          </div>
        </div>
      </aside>
      
      <!-- Main content -->
      <main class="config-main">
        <!-- Action bar -->
        <div class="config-actions">
          <div class="config-actions__left">
            ${hasChanges ? html`
              <span class="config-changes-badge">${diff.length} unsaved change${diff.length !== 1 ? "s" : ""}</span>
            ` : html`
              <span class="config-status muted">No changes</span>
            `}
          </div>
          <div class="config-actions__right">
            <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onReload}>
              ${props.loading ? "Loading…" : "Reload"}
            </button>
            <button
              class="btn btn--sm primary"
              ?disabled=${!canSave}
              @click=${props.onSave}
            >
              ${props.saving ? "Saving…" : "Save"}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!canApply}
              @click=${props.onApply}
            >
              ${props.applying ? "Applying…" : "Apply"}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!canUpdate}
              @click=${props.onUpdate}
            >
              ${props.updating ? "Updating…" : "Update"}
            </button>
          </div>
        </div>
        
        <!-- Diff panel -->
        ${hasChanges ? html`
          <details class="config-diff">
            <summary class="config-diff__summary">
              <span>View ${diff.length} pending change${diff.length !== 1 ? "s" : ""}</span>
              <svg class="config-diff__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </summary>
            <div class="config-diff__content">
              ${diff.map(change => html`
                <div class="config-diff__item">
                  <div class="config-diff__path">${change.path}</div>
                  <div class="config-diff__values">
                    <span class="config-diff__from">${truncateValue(change.from)}</span>
                    <span class="config-diff__arrow">→</span>
                    <span class="config-diff__to">${truncateValue(change.to)}</span>
                  </div>
                </div>
              `)}
            </div>
          </details>
        ` : nothing}

        <!-- Form content -->
        <div class="config-content">
          ${props.formMode === "form"
            ? html`
                ${props.schemaLoading
                  ? html`<div class="config-loading">
                      <div class="config-loading__spinner"></div>
                      <span>Loading schema…</span>
                    </div>`
                  : renderConfigForm({
                      schema: analysis.schema,
                      uiHints: props.uiHints,
                      value: props.formValue,
                      disabled: props.loading || !props.formValue,
                      unsupportedPaths: analysis.unsupportedPaths,
                      onPatch: props.onFormPatch,
                      searchQuery: props.searchQuery,
                      activeSection: props.activeSection,
                    })}
                ${formUnsafe
                  ? html`<div class="callout danger" style="margin-top: 12px;">
                      Form view can't safely edit some fields.
                      Use Raw to avoid losing config entries.
                    </div>`
                  : nothing}
              `
            : html`
                <label class="field config-raw-field">
                  <span>Raw JSON5</span>
                  <textarea
                    .value=${props.raw}
                    @input=${(e: Event) =>
                      props.onRawChange((e.target as HTMLTextAreaElement).value)}
                  ></textarea>
                </label>
              `}
        </div>

        ${props.issues.length > 0
          ? html`<div class="callout danger" style="margin-top: 12px;">
              <pre class="code-block">${JSON.stringify(props.issues, null, 2)}</pre>
            </div>`
          : nothing}
      </main>
    </div>
  `;
}
