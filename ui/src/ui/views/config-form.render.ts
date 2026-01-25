import { html, nothing } from "lit";
import { icon, type IconName } from "../icons";
import type { ConfigUiHints } from "../types";
import {
  hintForPath,
  humanize,
  schemaType,
  type ConfigValidationMap,
  type JsonSchema,
} from "./config-form.shared";
import { renderNode } from "./config-form.node";

export type ConfigFormProps = {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  disabled?: boolean;
  unsupportedPaths?: string[];
  searchQuery?: string;
  activeSection?: string | null;
  activeSubsection?: string | null;
  validation?: ConfigValidationMap;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

// Consolidated section configuration - single source of truth
// Each section has: icon, label, and description
type SectionConfig = {
  icon: IconName;
  label: string;
  description: string;
};

const SECTION_CONFIG: Record<string, SectionConfig> = {
  // Primary sections
  env: { icon: "server", label: "Environment Variables", description: "Environment variables passed to the gateway process" },
  update: { icon: "refresh-cw", label: "Updates", description: "Auto-update settings and release channel" },
  agents: { icon: "brain", label: "Agents", description: "Agent configurations, models, and identities" },
  auth: { icon: "user", label: "Authentication", description: "API keys and authentication profiles" },
  channels: { icon: "link", label: "Channels", description: "Messaging channels (Telegram, Discord, Slack, etc.)" },
  messages: { icon: "message-square", label: "Messages", description: "Message handling and routing settings" },
  commands: { icon: "scroll-text", label: "Commands", description: "Custom slash commands" },
  hooks: { icon: "link", label: "Hooks", description: "Webhooks and event hooks" },
  skills: { icon: "sparkles", label: "Skills", description: "Skill packs and capabilities" },
  tools: { icon: "settings", label: "Tools", description: "Tool configurations (browser, search, etc.)" },
  gateway: { icon: "panel-left", label: "Gateway", description: "Gateway server settings (port, auth, binding)" },
  wizard: { icon: "book-open", label: "Setup Wizard", description: "Setup wizard state and history" },
  // Additional sections
  meta: { icon: "info", label: "Metadata", description: "Gateway metadata and version information" },
  logging: { icon: "scroll-text", label: "Logging", description: "Log levels and output configuration" },
  browser: { icon: "maximize", label: "Browser", description: "Browser automation settings" },
  ui: { icon: "layout-dashboard", label: "UI", description: "User interface preferences" },
  models: { icon: "brain", label: "Models", description: "AI model configurations and providers" },
  bindings: { icon: "radio", label: "Bindings", description: "Key bindings and shortcuts" },
  broadcast: { icon: "send", label: "Broadcast", description: "Broadcast and notification settings" },
  audio: { icon: "radio", label: "Audio", description: "Audio input/output settings" },
  session: { icon: "clock", label: "Session", description: "Session management and persistence" },
  cron: { icon: "clock", label: "Cron", description: "Scheduled tasks and automation" },
  web: { icon: "server", label: "Web", description: "Web server and API settings" },
  discovery: { icon: "search", label: "Discovery", description: "Service discovery and networking" },
  canvasHost: { icon: "maximize", label: "Canvas Host", description: "Canvas rendering and display" },
  talk: { icon: "radio", label: "Talk", description: "Voice and speech settings" },
  plugins: { icon: "plus", label: "Plugins", description: "Plugin management and extensions" },
};

// Section metadata export (for backwards compatibility with config.ts)
export const SECTION_META: Record<string, { label: string; description: string }> = Object.fromEntries(
  Object.entries(SECTION_CONFIG).map(([key, config]) => [
    key,
    { label: config.label, description: config.description },
  ])
);

// Helper to get section icon
function getSectionIcon(key: string) {
  const config = SECTION_CONFIG[key];
  return icon(config?.icon ?? "file-text", { size: 20, strokeWidth: 1.5 });
}

// Helper to get full section config
function getSectionConfig(key: string): SectionConfig {
  return SECTION_CONFIG[key] ?? {
    icon: "file-text",
    label: key.charAt(0).toUpperCase() + key.slice(1),
    description: "",
  };
}

function matchesSearch(key: string, schema: JsonSchema, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const meta = SECTION_META[key];
  
  // Check key name
  if (key.toLowerCase().includes(q)) return true;
  
  // Check label and description
  if (meta) {
    if (meta.label.toLowerCase().includes(q)) return true;
    if (meta.description.toLowerCase().includes(q)) return true;
  }
  
  return schemaMatches(schema, q);
}

function schemaMatches(schema: JsonSchema, query: string): boolean {
  if (schema.title?.toLowerCase().includes(query)) return true;
  if (schema.description?.toLowerCase().includes(query)) return true;
  if (schema.enum?.some((value) => String(value).toLowerCase().includes(query))) return true;

  if (schema.properties) {
    for (const [propKey, propSchema] of Object.entries(schema.properties)) {
      if (propKey.toLowerCase().includes(query)) return true;
      if (schemaMatches(propSchema, query)) return true;
    }
  }

  if (schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      if (item && schemaMatches(item, query)) return true;
    }
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    if (schemaMatches(schema.additionalProperties, query)) return true;
  }

  const unions = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (unions) {
    for (const entry of unions) {
      if (entry && schemaMatches(entry, query)) return true;
    }
  }

  return false;
}

export function renderConfigForm(props: ConfigFormProps) {
  if (!props.schema) {
    return html`<div class="muted">Schema unavailable.</div>`;
  }
  const schema = props.schema;
  const value = props.value ?? {};
  if (schemaType(schema) !== "object" || !schema.properties) {
    return html`<div class="callout danger">Unsupported schema. Use Raw.</div>`;
  }
  const unsupported = new Set(props.unsupportedPaths ?? []);
  const properties = schema.properties;
  const searchQuery = props.searchQuery ?? "";
  const activeSection = props.activeSection;
  const activeSubsection = props.activeSubsection ?? null;

  const entries = Object.entries(properties).sort((a, b) => {
    const orderA = hintForPath([a[0]], props.uiHints)?.order ?? 50;
    const orderB = hintForPath([b[0]], props.uiHints)?.order ?? 50;
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });

  const filteredEntries = entries.filter(([key, node]) => {
    if (activeSection && key !== activeSection) return false;
    if (searchQuery && !matchesSearch(key, node, searchQuery)) return false;
    return true;
  });

  let subsectionContext:
    | { sectionKey: string; subsectionKey: string; schema: JsonSchema }
    | null = null;
  if (activeSection && activeSubsection && filteredEntries.length === 1) {
    const sectionSchema = filteredEntries[0]?.[1];
    if (
      sectionSchema &&
      schemaType(sectionSchema) === "object" &&
      sectionSchema.properties &&
      sectionSchema.properties[activeSubsection]
    ) {
      subsectionContext = {
        sectionKey: activeSection,
        subsectionKey: activeSubsection,
        schema: sectionSchema.properties[activeSubsection],
      };
    }
  }

  if (filteredEntries.length === 0) {
    return html`
      <div class="config-empty">
        <div class="config-empty__icon">🔍</div>
        <div class="config-empty__text">
          ${searchQuery 
            ? `No settings match "${searchQuery}"` 
            : "No settings in this section"}
        </div>
      </div>
    `;
  }

  return html`
    <div class="config-form config-form--modern">
      ${subsectionContext
        ? (() => {
            const { sectionKey, subsectionKey, schema: node } = subsectionContext;
            const hint = hintForPath([sectionKey, subsectionKey], props.uiHints);
            const label = hint?.label ?? node.title ?? humanize(subsectionKey);
            const description = hint?.help ?? node.description ?? "";
            const sectionValue = (value as Record<string, unknown>)[sectionKey];
            const scopedValue =
              sectionValue && typeof sectionValue === "object"
                ? (sectionValue as Record<string, unknown>)[subsectionKey]
                : undefined;
            const id = `config-section-${sectionKey}-${subsectionKey}`;
            return html`
              <section class="config-section-card" id=${id}>
                <div class="config-section-card__header">
                  <span class="config-section-card__icon">${getSectionIcon(sectionKey)}</span>
                  <div class="config-section-card__titles">
                    <h3 class="config-section-card__title">${label}</h3>
                    ${description
                      ? html`<p class="config-section-card__desc">${description}</p>`
                      : nothing}
                  </div>
                </div>
                <div class="config-section-card__content">
                  ${renderNode({
                    schema: node,
                    value: scopedValue,
                    path: [sectionKey, subsectionKey],
                    hints: props.uiHints,
                    unsupported,
                    disabled: props.disabled ?? false,
                    showLabel: false,
                    validation: props.validation,
                    onPatch: props.onPatch,
                  })}
                </div>
              </section>
            `;
          })()
        : filteredEntries.map(([key, node]) => {
            const config = getSectionConfig(key);
            // Use schema description as fallback if config description is empty
            const description = config.description || node.description || "";

            return html`
              <section class="config-section-card" id="config-section-${key}">
                <div class="config-section-card__header">
                  <span class="config-section-card__icon">${getSectionIcon(key)}</span>
                  <div class="config-section-card__titles">
                    <h3 class="config-section-card__title">${config.label}</h3>
                    ${description
                      ? html`<p class="config-section-card__desc">${description}</p>`
                      : nothing}
                  </div>
                </div>
                <div class="config-section-card__content">
                  ${renderNode({
                    schema: node,
                    value: (value as Record<string, unknown>)[key],
                    path: [key],
                    hints: props.uiHints,
                    unsupported,
                    disabled: props.disabled ?? false,
                    showLabel: false,
                    validation: props.validation,
                    onPatch: props.onPatch,
                  })}
                </div>
              </section>
            `;
          })}
    </div>
  `;
}
