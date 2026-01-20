import { html, nothing } from "lit";
import type { ConfigUiHints } from "../types";
import { hintForPath, schemaType, type JsonSchema } from "./config-form.shared";
import { renderNode } from "./config-form.node";

export type ConfigFormProps = {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  disabled?: boolean;
  unsupportedPaths?: string[];
  searchQuery?: string;
  activeSection?: string | null;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

// Section metadata
const SECTION_META: Record<string, { label: string; icon: string; description: string }> = {
  env: { 
    label: "Environment Variables", 
    icon: "🔧",
    description: "Environment variables passed to the gateway process"
  },
  update: { 
    label: "Updates", 
    icon: "📦",
    description: "Auto-update settings and release channel"
  },
  agents: { 
    label: "Agents", 
    icon: "🤖",
    description: "Agent configurations, models, and identities"
  },
  auth: { 
    label: "Authentication", 
    icon: "🔐",
    description: "API keys and authentication profiles"
  },
  channels: { 
    label: "Channels", 
    icon: "💬",
    description: "Messaging channels (Telegram, Discord, Slack, etc.)"
  },
  messages: { 
    label: "Messages", 
    icon: "📨",
    description: "Message handling and routing settings"
  },
  commands: { 
    label: "Commands", 
    icon: "⌨️",
    description: "Custom slash commands"
  },
  hooks: { 
    label: "Hooks", 
    icon: "🪝",
    description: "Webhooks and event hooks"
  },
  skills: { 
    label: "Skills", 
    icon: "✨",
    description: "Skill packs and capabilities"
  },
  tools: { 
    label: "Tools", 
    icon: "🛠️",
    description: "Tool configurations (browser, search, etc.)"
  },
  gateway: { 
    label: "Gateway", 
    icon: "🌐",
    description: "Gateway server settings (port, auth, binding)"
  },
  wizard: { 
    label: "Setup Wizard", 
    icon: "🧙",
    description: "Setup wizard state and history"
  },
};

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
  
  // Check schema title/description
  if (schema.title?.toLowerCase().includes(q)) return true;
  if (schema.description?.toLowerCase().includes(q)) return true;
  
  // Deep search in properties
  if (schema.properties) {
    for (const [propKey, propSchema] of Object.entries(schema.properties)) {
      if (propKey.toLowerCase().includes(q)) return true;
      if (propSchema.title?.toLowerCase().includes(q)) return true;
      if (propSchema.description?.toLowerCase().includes(q)) return true;
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

  // Filter and sort entries
  let entries = Object.entries(properties);
  
  // Filter by active section
  if (activeSection) {
    entries = entries.filter(([key]) => key === activeSection);
  }
  
  // Filter by search
  if (searchQuery) {
    entries = entries.filter(([key, node]) => matchesSearch(key, node, searchQuery));
  }
  
  // Sort by hint order, then alphabetically
  entries.sort((a, b) => {
    const orderA = hintForPath([a[0]], props.uiHints)?.order ?? 50;
    const orderB = hintForPath([b[0]], props.uiHints)?.order ?? 50;
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });

  if (entries.length === 0) {
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
      ${entries.map(([key, node]) => {
        const meta = SECTION_META[key] ?? { 
          label: key.charAt(0).toUpperCase() + key.slice(1), 
          icon: "📄",
          description: node.description ?? ""
        };
        
        return html`
          <section class="config-section-card" id="config-section-${key}">
            <div class="config-section-card__header">
              <span class="config-section-card__icon">${meta.icon}</span>
              <div class="config-section-card__titles">
                <h3 class="config-section-card__title">${meta.label}</h3>
                ${meta.description ? html`
                  <p class="config-section-card__desc">${meta.description}</p>
                ` : nothing}
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
                onPatch: props.onPatch,
                searchQuery,
              })}
            </div>
          </section>
        `;
      })}
    </div>
  `;
}
