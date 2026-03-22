import { html } from "lit";
import type { ConfigUiHints } from "../types.ts";
import { formatChannelExtraValue, resolveChannelConfigValue } from "./channel-config-extras.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { analyzeConfigSchema, renderNode, schemaType, type JsonSchema } from "./config-form.ts";

type ChannelConfigFormProps = {
  channelId: string;
  accountId?: string | null;
  configValue: Record<string, unknown> | null;
  schema: unknown;
  uiHints: ConfigUiHints;
  disabled: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

function resolveSchemaNode(
  schema: JsonSchema | null,
  path: Array<string | number>,
): JsonSchema | null {
  let current = schema;
  for (const key of path) {
    if (!current) {
      return null;
    }
    const type = schemaType(current);
    if (type === "object") {
      const properties = current.properties ?? {};
      if (typeof key === "string" && properties[key]) {
        current = properties[key];
        continue;
      }
      const additional = current.additionalProperties;
      if (typeof key === "string" && additional && typeof additional === "object") {
        current = additional;
        continue;
      }
      return null;
    }
    if (type === "array") {
      if (typeof key !== "number") {
        return null;
      }
      const items = Array.isArray(current.items) ? current.items[0] : current.items;
      current = items ?? null;
      continue;
    }
    return null;
  }
  return current;
}

function resolveScopedChannelPath(channelId: string, accountId?: string | null): Array<string> {
  return accountId?.trim()
    ? ["channels", channelId, "accounts", accountId]
    : ["channels", channelId];
}

function resolveChannelValue(
  config: Record<string, unknown>,
  channelId: string,
  accountId?: string | null,
): Record<string, unknown> {
  return resolveChannelConfigValue(config, channelId, accountId) ?? {};
}

const EXTRA_CHANNEL_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

function renderExtraChannelFields(value: Record<string, unknown>) {
  const entries = EXTRA_CHANNEL_FIELDS.flatMap((field) => {
    if (!(field in value)) {
      return [];
    }
    return [[field, value[field]]] as Array<[string, unknown]>;
  });
  if (entries.length === 0) {
    return null;
  }
  return html`
    <div class="status-list" style="margin-top: 12px;">
      ${entries.map(
        ([field, raw]) => html`
          <div>
            <span class="label">${field}</span>
            <span>${formatChannelExtraValue(raw)}</span>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderChannelConfigForm(props: ChannelConfigFormProps) {
  const analysis = analyzeConfigSchema(props.schema);
  const normalized = analysis.schema;
  if (!normalized) {
    return html`
      <div class="callout danger">Schema unavailable. Use Raw.</div>
    `;
  }
  const scopedPath = resolveScopedChannelPath(props.channelId, props.accountId);
  const node = resolveSchemaNode(normalized, scopedPath);
  if (!node) {
    return html`
      <div class="callout danger">Channel config schema unavailable.</div>
    `;
  }
  const configValue = props.configValue ?? {};
  const value = resolveChannelValue(configValue, props.channelId, props.accountId);
  return html`
    <div class="config-form">
      ${renderNode({
        schema: node,
        value,
        path: scopedPath,
        hints: props.uiHints,
        unsupported: new Set(analysis.unsupportedPaths),
        disabled: props.disabled,
        showLabel: false,
        onPatch: props.onPatch,
      })}
    </div>
    ${renderExtraChannelFields(value)}
  `;
}

function resolvePreferredChannelAccountId(channelId: string, props: ChannelsProps): string | null {
  const defaultAccountId = props.snapshot?.channelDefaultAccountId?.[channelId];
  if (defaultAccountId?.trim()) {
    return defaultAccountId;
  }
  const accounts = props.snapshot?.channelAccounts?.[channelId] ?? [];
  const configured = accounts.find((account) => account.configured && account.accountId?.trim());
  return configured?.accountId?.trim() || accounts[0]?.accountId?.trim() || null;
}

export function renderChannelConfigSection(params: { channelId: string; props: ChannelsProps }) {
  const { channelId, props } = params;
  const disabled = props.configSaving || props.configSchemaLoading;
  const accountId = resolvePreferredChannelAccountId(channelId, props);
  return html`
    <div style="margin-top: 16px;">
      ${
        props.configSchemaLoading
          ? html`
              <div class="muted">Loading config schema…</div>
            `
          : renderChannelConfigForm({
              channelId,
              accountId,
              configValue: props.configForm,
              schema: props.configSchema,
              uiHints: props.configUiHints,
              disabled,
              onPatch: props.onConfigPatch,
            })
      }
      <div class="row" style="margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${disabled || !props.configFormDirty}
          @click=${() => props.onConfigSave()}
        >
          ${props.configSaving ? "Saving…" : "Save"}
        </button>
        <button
          class="btn"
          ?disabled=${disabled}
          @click=${() => props.onConfigReload()}
        >
          Reload
        </button>
      </div>
    </div>
  `;
}
