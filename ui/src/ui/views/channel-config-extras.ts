function resolveChannelRootValue(
  configForm: Record<string, unknown> | null | undefined,
  channelId: string,
): Record<string, unknown> | null {
  if (!configForm) {
    return null;
  }
  const channels = (configForm.channels ?? {}) as Record<string, unknown>;
  const fromChannels = channels[channelId];
  if (fromChannels && typeof fromChannels === "object") {
    return fromChannels as Record<string, unknown>;
  }
  const fallback = configForm[channelId];
  if (fallback && typeof fallback === "object") {
    return fallback as Record<string, unknown>;
  }
  return null;
}

export function resolveChannelAccountConfigValue(
  configForm: Record<string, unknown> | null | undefined,
  channelId: string,
  accountId: string | null | undefined,
): Record<string, unknown> | null {
  const channel = resolveChannelRootValue(configForm, channelId);
  if (!channel || !accountId?.trim()) {
    return null;
  }
  const accounts = channel.accounts;
  if (!accounts || typeof accounts !== "object") {
    return null;
  }
  const account = (accounts as Record<string, unknown>)[accountId];
  return account && typeof account === "object" ? (account as Record<string, unknown>) : null;
}

export function resolveChannelConfigValue(
  configForm: Record<string, unknown> | null | undefined,
  channelId: string,
  accountId?: string | null,
): Record<string, unknown> | null {
  return (
    resolveChannelAccountConfigValue(configForm, channelId, accountId) ??
    resolveChannelRootValue(configForm, channelId)
  );
}

export function formatChannelExtraValue(raw: unknown): string {
  if (raw == null) {
    return "n/a";
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return "n/a";
  }
}

export function resolveChannelExtras(params: {
  configForm: Record<string, unknown> | null | undefined;
  channelId: string;
  fields: readonly string[];
}): Array<{ label: string; value: string }> {
  const value = resolveChannelConfigValue(params.configForm, params.channelId);
  if (!value) {
    return [];
  }
  return params.fields.flatMap((field) => {
    if (!(field in value)) {
      return [];
    }
    return [{ label: field, value: formatChannelExtraValue(value[field]) }];
  });
}
