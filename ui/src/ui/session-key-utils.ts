export type UiSessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
};

export function readUiSessionDefaults(
  hello?: { snapshot?: unknown } | null,
): UiSessionDefaultsSnapshot | undefined {
  const snapshot = hello?.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const defaults = (snapshot as { sessionDefaults?: unknown }).sessionDefaults;
  if (!defaults || typeof defaults !== "object") {
    return undefined;
  }
  return defaults as UiSessionDefaultsSnapshot;
}

export function canonicalizeUiSessionKey(
  value: string | undefined,
  defaults?: UiSessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  if (!raw) {
    return raw;
  }
  const lowered = raw.toLowerCase();
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  if (lowered.startsWith("agent:")) {
    return lowered;
  }
  const defaultAgentId = defaults?.defaultAgentId?.trim().toLowerCase() || "main";
  const mainKey = defaults?.mainKey?.trim().toLowerCase() || "main";
  const mainSessionKey = defaults?.mainSessionKey?.trim().toLowerCase();
  if (mainSessionKey && (lowered === "main" || lowered === mainKey)) {
    return mainSessionKey;
  }
  return `agent:${defaultAgentId}:${lowered}`;
}

export function areEquivalentUiSessionKeys(
  left: string | undefined,
  right: string | undefined,
  defaults?: UiSessionDefaultsSnapshot,
): boolean {
  return canonicalizeUiSessionKey(left, defaults) === canonicalizeUiSessionKey(right, defaults);
}
