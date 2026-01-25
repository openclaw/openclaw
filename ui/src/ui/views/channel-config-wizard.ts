/**
 * Channel Configuration Wizard
 *
 * A large, multi-pane configuration dialog for channel integrations.
 * Features:
 * - Left sidebar with section navigation
 * - Main content area with config fields
 * - Dirty state tracking with unsaved changes protection
 * - Section validation indicators
 */

import { html, nothing, type TemplateResult } from "lit";

import { icon, type IconName } from "../icons";
import type { ConfigUiHints } from "../types";
import type { ChannelKey, ChannelsProps } from "./channels.types";
import {
  analyzeConfigSchema,
  renderNode,
  schemaType,
  type JsonSchema,
} from "./config-form";

// ============================================================================
// Types
// ============================================================================

export type WizardSection = {
  id: string;
  label: string;
  icon: IconName;
  description: string;
  /** Fields in this section (JSON path segments from channel root) */
  fields?: string[];
  /** Whether this section has validation issues */
  hasErrors?: boolean;
  /** Whether this section has required unfilled fields */
  hasRequired?: boolean;
};

export type ChannelWizardState = {
  open: boolean;
  channelId: ChannelKey | null;
  activeSection: string;
  isDirty: boolean;
  showConfirmClose: boolean;
  /** Pending action after confirm: 'close' | 'discard' */
  pendingAction: "close" | "discard" | null;
};

// ============================================================================
// Section Definitions
// ============================================================================

/**
 * Default sections for channel configuration.
 * These are generic and apply to most channels.
 * Note: Fields not matching any section will appear in "Other Settings".
 */
export const DEFAULT_CHANNEL_SECTIONS: WizardSection[] = [
  {
    id: "authentication",
    label: "Authentication",
    icon: "user",
    description: "API tokens, credentials, and connection settings",
    fields: ["token", "botToken", "appToken", "userToken", "apiKey", "signingSecret", "serviceAccount", "account", "credentials"],
  },
  {
    id: "general",
    label: "General Settings",
    icon: "settings",
    description: "Basic configuration like name, enabled state, and capabilities",
    fields: ["name", "enabled", "capabilities", "mode", "label", "description"],
  },
  {
    id: "access",
    label: "Access Control",
    icon: "check-circle",
    description: "DM policies, group policies, and allowlists",
    fields: ["dmPolicy", "dm", "groupPolicy", "allowFrom", "groupAllowFrom", "allowBots", "requireMention", "allowlist", "blocklist", "adminOnly"],
  },
  {
    id: "messaging",
    label: "Messaging",
    icon: "message-square",
    description: "Text handling, streaming, and message formatting",
    fields: ["textChunkLimit", "blockStreaming", "blockStreamingCoalesce", "markdown", "commands", "configWrites", "replyToMode", "typing", "readReceipts"],
  },
  {
    id: "history",
    label: "History & Context",
    icon: "history",
    description: "Message history limits and per-chat overrides",
    fields: ["historyLimit", "dmHistoryLimit", "dms", "groups", "channels", "guilds", "threads", "contextWindow"],
  },
  {
    id: "reactions",
    label: "Reactions & Actions",
    icon: "sparkles",
    description: "Reaction notifications, acknowledgments, and tool permissions",
    fields: ["reactionNotifications", "reactionAllowlist", "reactionLevel", "ackReaction", "actions", "reactions", "emoji"],
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: "settings",
    description: "Webhooks, retry policies, and special features",
    fields: ["retry", "webhookUrl", "webhookPath", "webhookSecret", "proxy", "mediaMaxMb", "timeoutSeconds", "heartbeat", "debug", "verbose"],
  },
];

/**
 * Build sections for a specific channel, including an "Other Settings" section
 * for any fields not covered by the default sections.
 */
export function buildChannelSections(channelSchema: JsonSchema | null): WizardSection[] {
  if (!channelSchema?.properties) {
    return DEFAULT_CHANNEL_SECTIONS;
  }

  const allSchemaFields = Object.keys(channelSchema.properties);
  const coveredFields = new Set<string>();

  // Collect all fields covered by default sections
  for (const section of DEFAULT_CHANNEL_SECTIONS) {
    if (section.fields) {
      for (const field of section.fields) {
        coveredFields.add(field);
      }
    }
  }

  // Find uncovered fields
  const uncoveredFields = allSchemaFields.filter((field) => !coveredFields.has(field));

  // If there are uncovered fields, add an "Other Settings" section
  if (uncoveredFields.length > 0) {
    return [
      ...DEFAULT_CHANNEL_SECTIONS,
      {
        id: "other",
        label: "Other Settings",
        icon: "file-text",
        description: "Additional channel-specific configuration options",
        fields: uncoveredFields,
      },
    ];
  }

  return DEFAULT_CHANNEL_SECTIONS;
}

// ============================================================================
// Helpers
// ============================================================================

function resolveSchemaNode(
  schema: JsonSchema | null,
  path: Array<string | number>,
): JsonSchema | null {
  let current = schema;
  for (const key of path) {
    if (!current) return null;
    const type = schemaType(current);
    if (type === "object") {
      const properties = current.properties ?? {};
      if (typeof key === "string" && properties[key]) {
        current = properties[key];
        continue;
      }
      const additional = current.additionalProperties;
      if (typeof key === "string" && additional && typeof additional === "object") {
        current = additional as JsonSchema;
        continue;
      }
      return null;
    }
    if (type === "array") {
      if (typeof key !== "number") return null;
      const items = Array.isArray(current.items) ? current.items[0] : current.items;
      current = items ?? null;
      continue;
    }
    return null;
  }
  return current;
}

function resolveChannelValue(
  config: Record<string, unknown>,
  channelId: string,
): Record<string, unknown> {
  const channels = (config.channels ?? {}) as Record<string, unknown>;
  const fromChannels = channels[channelId];
  const fallback = config[channelId];
  const resolved =
    (fromChannels && typeof fromChannels === "object"
      ? (fromChannels as Record<string, unknown>)
      : null) ??
    (fallback && typeof fallback === "object"
      ? (fallback as Record<string, unknown>)
      : null);
  return resolved ?? {};
}

function getChannelTitle(channelId: ChannelKey): string {
  const titles: Record<ChannelKey, string> = {
    discord: "Discord",
    slack: "Slack",
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    signal: "Signal",
    imessage: "iMessage",
    googlechat: "Google Chat",
    nostr: "Nostr",
  };
  return titles[channelId] || channelId;
}

function getChannelIcon(channelId: ChannelKey): IconName {
  // For now, use generic icons. In production, you'd have brand icons.
  const icons: Record<ChannelKey, IconName> = {
    discord: "message-square",
    slack: "message-square",
    telegram: "send",
    whatsapp: "message-square",
    signal: "radio",
    imessage: "message-square",
    googlechat: "message-square",
    nostr: "zap",
  };
  return icons[channelId] || "message-square";
}

/**
 * Get fields that exist in the schema for a given section
 */
function getSectionFields(
  section: WizardSection,
  channelSchema: JsonSchema | null,
): string[] {
  if (!channelSchema || !channelSchema.properties || !section.fields) {
    return [];
  }
  const props = channelSchema.properties;
  return section.fields.filter((field) => props[field] !== undefined);
}

/**
 * Check if a section has any configurable fields
 */
function sectionHasFields(
  section: WizardSection,
  channelSchema: JsonSchema | null,
): boolean {
  return getSectionFields(section, channelSchema).length > 0;
}

// ============================================================================
// Render Functions
// ============================================================================

/**
 * Render the sidebar navigation
 */
function renderSidebar(params: {
  sections: WizardSection[];
  activeSection: string;
  channelSchema: JsonSchema | null;
  onSectionClick: (sectionId: string) => void;
}): TemplateResult {
  const { sections, activeSection, channelSchema, onSectionClick } = params;

  const visibleSections = sections.filter((s) => sectionHasFields(s, channelSchema));

  return html`
    <div class="channel-wizard__sidebar">
      <nav class="channel-wizard__nav">
        ${visibleSections.map((section) => {
          const isActive = section.id === activeSection;
          const statusClass = section.hasErrors
            ? "channel-wizard__nav-status--error"
            : section.hasRequired
              ? "channel-wizard__nav-status--warning"
              : "channel-wizard__nav-status--valid";

          return html`
            <button
              type="button"
              class="channel-wizard__nav-item ${isActive ? "channel-wizard__nav-item--active" : ""}"
              @click=${() => onSectionClick(section.id)}
            >
              <span class="channel-wizard__nav-icon">
                ${icon(section.icon, { size: 16 })}
              </span>
              <span class="channel-wizard__nav-label">${section.label}</span>
              <span class="channel-wizard__nav-status ${statusClass}">
                ${section.hasErrors
                  ? icon("alert-circle", { size: 16 })
                  : section.hasRequired
                    ? icon("alert-triangle", { size: 16 })
                    : icon("check", { size: 16 })}
              </span>
            </button>
          `;
        })}
      </nav>
    </div>
  `;
}

/**
 * Render the content area for the active section
 */
function renderContent(params: {
  section: WizardSection;
  channelId: ChannelKey;
  channelSchema: JsonSchema | null;
  channelValue: Record<string, unknown>;
  uiHints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { section, channelId, channelSchema, channelValue, uiHints, unsupported, disabled, onPatch } = params;

  if (!channelSchema || !channelSchema.properties) {
    return html`
      <div class="channel-wizard__content">
        <div class="channel-wizard__content-header">
          <h3 class="channel-wizard__section-title">${section.label}</h3>
          <p class="channel-wizard__section-desc">${section.description}</p>
        </div>
        <div class="channel-wizard__content-body">
          <div class="callout danger">Schema unavailable for this channel.</div>
        </div>
      </div>
    `;
  }

  const sectionFields = getSectionFields(section, channelSchema);

  // Build a filtered schema with only this section's fields
  const filteredProperties: Record<string, JsonSchema> = {};
  for (const field of sectionFields) {
    if (channelSchema.properties[field]) {
      filteredProperties[field] = channelSchema.properties[field];
    }
  }

  const filteredSchema: JsonSchema = {
    type: "object",
    properties: filteredProperties,
  };

  return html`
    <div class="channel-wizard__content">
      <div class="channel-wizard__content-header">
        <h3 class="channel-wizard__section-title">${section.label}</h3>
        <p class="channel-wizard__section-desc">${section.description}</p>
      </div>
      <div class="channel-wizard__content-body">
        <div class="channel-wizard__form">
          ${renderNode({
            schema: filteredSchema,
            value: channelValue,
            path: ["channels", channelId],
            hints: uiHints,
            unsupported,
            disabled,
            showLabel: false,
            onPatch,
          })}
        </div>
      </div>
    </div>
  `;
}

/**
 * Render the confirm discard dialog
 */
function renderConfirmDialog(params: {
  onKeepEditing: () => void;
  onDiscard: () => void;
}): TemplateResult {
  return html`
    <div class="channel-wizard-confirm__backdrop" @click=${params.onKeepEditing}></div>
    <div class="channel-wizard-confirm">
      <div class="channel-wizard-confirm__header">
        <div class="channel-wizard-confirm__title">Discard unsaved changes?</div>
      </div>
      <div class="channel-wizard-confirm__body">
        <p class="channel-wizard-confirm__message">
          You have unsaved changes. Are you sure you want to discard them? This action cannot be undone.
        </p>
      </div>
      <div class="channel-wizard-confirm__footer">
        <button type="button" class="btn btn--sm" @click=${params.onKeepEditing}>
          Keep Editing
        </button>
        <button type="button" class="btn btn--sm danger" @click=${params.onDiscard}>
          Discard Changes
        </button>
      </div>
    </div>
  `;
}

// ============================================================================
// Main Wizard Component
// ============================================================================

export type ChannelWizardProps = {
  state: ChannelWizardState;
  props: ChannelsProps;
  onClose: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onSectionChange: (sectionId: string) => void;
  onConfirmClose: () => void;
  onCancelClose: () => void;
};

/**
 * Render the channel configuration wizard
 */
export function renderChannelWizard(params: ChannelWizardProps): TemplateResult | typeof nothing {
  const { state, props, onClose, onSave, onDiscard, onSectionChange, onConfirmClose, onCancelClose } = params;

  if (!state.open || !state.channelId) {
    return nothing;
  }

  const channelId = state.channelId;
  const analysis = analyzeConfigSchema(props.configSchema);
  const normalizedSchema = analysis.schema;

  const channelSchema = normalizedSchema
    ? resolveSchemaNode(normalizedSchema, ["channels", channelId])
    : null;

  const configValue = props.configForm ?? {};
  const channelValue = resolveChannelValue(configValue, channelId);

  const disabled = props.configSaving || props.configSchemaLoading;
  // Build sections dynamically to include "Other Settings" for uncovered fields
  const sections = buildChannelSections(channelSchema);
  const activeSection = sections.find((s) => s.id === state.activeSection) || sections[0];

  const handleCloseClick = () => {
    if (state.isDirty) {
      onConfirmClose();
    } else {
      onClose();
    }
  };

  const handleDiscardClick = () => {
    if (state.isDirty) {
      onConfirmClose();
    }
  };

  return html`
    <div class="channel-wizard-backdrop" @click=${handleCloseClick}></div>
    <div class="channel-wizard" @click=${(e: Event) => e.stopPropagation()}>
      <!-- Header -->
      <div class="channel-wizard__header">
        <div class="channel-wizard__header-left">
          <div class="channel-wizard__icon">
            ${icon(getChannelIcon(channelId), { size: 24 })}
          </div>
          <div class="channel-wizard__titles">
            <h2 class="channel-wizard__title">${getChannelTitle(channelId)} Configuration</h2>
            <p class="channel-wizard__subtitle">Configure your ${getChannelTitle(channelId)} integration</p>
          </div>
        </div>
        <div class="channel-wizard__header-right">
          ${state.isDirty
            ? html`
                <span class="channel-wizard__dirty-badge">
                  ${icon("alert-circle", { size: 14 })}
                  Unsaved Changes
                </span>
              `
            : nothing}
          <button
            type="button"
            class="channel-wizard__close"
            @click=${handleCloseClick}
            title="Close"
          >
            ${icon("x", { size: 20 })}
          </button>
        </div>
      </div>

      <!-- Body -->
      <div class="channel-wizard__body">
        ${renderSidebar({
          sections,
          activeSection: state.activeSection,
          channelSchema,
          onSectionClick: onSectionChange,
        })}

        ${renderContent({
          section: activeSection,
          channelId,
          channelSchema,
          channelValue,
          uiHints: props.configUiHints,
          unsupported: new Set(analysis.unsupportedPaths),
          disabled,
          onPatch: props.onConfigPatch,
        })}
      </div>

      <!-- Footer -->
      <div class="channel-wizard__footer">
        <div class="channel-wizard__footer-hint ${state.isDirty ? "channel-wizard__footer-hint--warning" : ""}">
          ${state.isDirty ? "* You have unsaved changes" : ""}
        </div>
        <div class="channel-wizard__footer-actions">
          <button
            type="button"
            class="btn btn--sm"
            @click=${handleCloseClick}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${!state.isDirty}
            @click=${handleDiscardClick}
          >
            Discard
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${!state.isDirty || disabled}
            @click=${onSave}
          >
            ${props.configSaving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>

    ${state.showConfirmClose
      ? renderConfirmDialog({
          onKeepEditing: onCancelClose,
          onDiscard: () => {
            onDiscard();
            onClose();
          },
        })
      : nothing}
  `;
}

// ============================================================================
// State Management Helpers
// ============================================================================

/**
 * Create initial wizard state
 */
export function createWizardState(): ChannelWizardState {
  return {
    open: false,
    channelId: null,
    activeSection: "authentication",
    isDirty: false,
    showConfirmClose: false,
    pendingAction: null,
  };
}

/**
 * Open the wizard for a specific channel
 */
export function openWizard(
  state: ChannelWizardState,
  channelId: ChannelKey,
): ChannelWizardState {
  return {
    ...state,
    open: true,
    channelId,
    activeSection: "authentication",
    isDirty: false,
    showConfirmClose: false,
    pendingAction: null,
  };
}

/**
 * Close the wizard
 */
export function closeWizard(state: ChannelWizardState): ChannelWizardState {
  return {
    ...state,
    open: false,
    showConfirmClose: false,
    pendingAction: null,
  };
}

/**
 * Set the active section
 */
export function setActiveSection(
  state: ChannelWizardState,
  sectionId: string,
): ChannelWizardState {
  return {
    ...state,
    activeSection: sectionId,
  };
}

/**
 * Mark the wizard as having unsaved changes
 */
export function setDirty(
  state: ChannelWizardState,
  isDirty: boolean,
): ChannelWizardState {
  return {
    ...state,
    isDirty,
  };
}

/**
 * Show the confirm close dialog
 */
export function showConfirmClose(state: ChannelWizardState): ChannelWizardState {
  return {
    ...state,
    showConfirmClose: true,
  };
}

/**
 * Hide the confirm close dialog
 */
export function hideConfirmClose(state: ChannelWizardState): ChannelWizardState {
  return {
    ...state,
    showConfirmClose: false,
    pendingAction: null,
  };
}
