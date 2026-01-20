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
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

// Define logical section groupings
const SECTION_CONFIG: Record<string, { label: string; icon: string; order: number }> = {
  // Core
  env: { label: "Environment", icon: "🔧", order: 0 },
  update: { label: "Updates", icon: "📦", order: 1 },
  
  // Identity & Agents
  agents: { label: "Agents", icon: "🤖", order: 10 },
  auth: { label: "Authentication", icon: "🔐", order: 11 },
  
  // Communication
  channels: { label: "Channels", icon: "💬", order: 20 },
  messages: { label: "Messages", icon: "📨", order: 21 },
  
  // Automation
  commands: { label: "Commands", icon: "⌨️", order: 30 },
  hooks: { label: "Hooks", icon: "🪝", order: 31 },
  skills: { label: "Skills", icon: "✨", order: 32 },
  
  // Tools & Gateway
  tools: { label: "Tools", icon: "🛠️", order: 40 },
  gateway: { label: "Gateway", icon: "🌐", order: 41 },
  
  // System
  wizard: { label: "Setup Wizard", icon: "🧙", order: 50 },
};

// Logical groupings for the accordion layout
const SECTION_GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: "Core Settings", keys: ["env", "update"] },
  { title: "Identity & Agents", keys: ["agents", "auth"] },
  { title: "Communication", keys: ["channels", "messages"] },
  { title: "Automation", keys: ["commands", "hooks", "skills"] },
  { title: "Tools & Gateway", keys: ["tools", "gateway"] },
  { title: "System", keys: ["wizard"] },
];

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
  const allKeys = new Set(Object.keys(properties));

  // Collect any keys not in our defined groups
  const groupedKeys = new Set(SECTION_GROUPS.flatMap(g => g.keys));
  const ungroupedKeys = [...allKeys].filter(k => !groupedKeys.has(k));

  // Build the groups with their entries
  const groups = SECTION_GROUPS.map(group => {
    const entries = group.keys
      .filter(key => allKeys.has(key))
      .map(key => ({ key, node: properties[key] }));
    return { ...group, entries };
  }).filter(group => group.entries.length > 0);

  // Add ungrouped keys as "Other" if any exist
  if (ungroupedKeys.length > 0) {
    const sortedUngrouped = ungroupedKeys.sort((a, b) => {
      const orderA = hintForPath([a], props.uiHints)?.order ?? 100;
      const orderB = hintForPath([b], props.uiHints)?.order ?? 100;
      if (orderA !== orderB) return orderA - orderB;
      return a.localeCompare(b);
    });
    groups.push({
      title: "Other",
      keys: sortedUngrouped,
      entries: sortedUngrouped.map(key => ({ key, node: properties[key] })),
    });
  }

  return html`
    <div class="config-form config-form--sectioned">
      ${groups.map((group, groupIndex) => html`
        <details class="config-section" ?open=${groupIndex === 0}>
          <summary class="config-section__header">
            <span class="config-section__title">${group.title}</span>
            <span class="config-section__count">${group.entries.length} ${group.entries.length === 1 ? 'setting' : 'settings'}</span>
            <svg class="config-section__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </summary>
          <div class="config-section__content">
            ${group.entries.map(({ key, node }) => {
              const sectionInfo = SECTION_CONFIG[key];
              const icon = sectionInfo?.icon ?? "📄";
              const label = sectionInfo?.label ?? key;
              
              return html`
                <div class="config-field-group">
                  <div class="config-field-group__header">
                    <span class="config-field-group__icon">${icon}</span>
                    <span class="config-field-group__label">${label}</span>
                  </div>
                  <div class="config-field-group__content">
                    ${renderNode({
                      schema: node,
                      value: (value as Record<string, unknown>)[key],
                      path: [key],
                      hints: props.uiHints,
                      unsupported,
                      disabled: props.disabled ?? false,
                      showLabel: false,
                      onPatch: props.onPatch,
                    })}
                  </div>
                </div>
              `;
            })}
          </div>
        </details>
      `)}
    </div>
  `;
}
