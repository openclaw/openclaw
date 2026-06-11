const DEFAULT_DREAMING_PLUGIN_ID = "memory-core";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return fallback;
}

function resolveDreamingPluginId(configValue: Record<string, unknown> | null): string {
  const plugins = asRecord(configValue?.plugins);
  const slots = asRecord(plugins?.slots);
  const configuredSlot = normalizeTrimmedString(slots?.memory);
  if (configuredSlot && configuredSlot.toLowerCase() !== "none") {
    return configuredSlot;
  }
  return DEFAULT_DREAMING_PLUGIN_ID;
}

export function resolveConfiguredDreaming(configValue: Record<string, unknown> | null): {
  pluginId: string;
  enabled: boolean;
} {
  const pluginId = resolveDreamingPluginId(configValue);
  const plugins = asRecord(configValue?.plugins);
  const entries = asRecord(plugins?.entries);
  const pluginEntry = asRecord(entries?.[pluginId]);
  const config = asRecord(pluginEntry?.config);
  const dreaming = asRecord(config?.dreaming);
  return {
    pluginId,
    enabled: normalizeBoolean(dreaming?.enabled, false),
  };
}
