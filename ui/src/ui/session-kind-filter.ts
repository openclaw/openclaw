import { parseAgentSessionKey, isSubagentSessionKey } from "./session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";
import type { SessionsListResult } from "./types.ts";

export const SESSION_DROPDOWN_KINDS = [
  "main",
  "group",
  "subagent",
  "dreaming",
  "cron",
  "other",
] as const;

export type SessionDropdownKind = (typeof SESSION_DROPDOWN_KINDS)[number];

export type SessionKindVisibility = Record<SessionDropdownKind, boolean>;

export const DEFAULT_SESSION_KIND_VISIBILITY = {
  main: true,
  group: true,
  subagent: true,
  dreaming: true,
  cron: false,
  other: true,
} as const satisfies SessionKindVisibility;

export function createDefaultSessionKindVisibility(): SessionKindVisibility {
  return { ...DEFAULT_SESSION_KIND_VISIBILITY };
}

export function resolveSessionKindVisibility(
  value: Partial<SessionKindVisibility> | null | undefined,
): SessionKindVisibility {
  return SESSION_DROPDOWN_KINDS.reduce<SessionKindVisibility>((next, kind) => {
    next[kind] =
      typeof value?.[kind] === "boolean" ? value[kind] : DEFAULT_SESSION_KIND_VISIBILITY[kind];
    return next;
  }, {} as SessionKindVisibility);
}

export function setSessionKindVisible(
  value: Partial<SessionKindVisibility> | null | undefined,
  kind: SessionDropdownKind,
  visible: boolean,
): SessionKindVisibility {
  return {
    ...resolveSessionKindVisibility(value),
    [kind]: visible,
  };
}

export function isCronSessionKey(key: string | undefined | null): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(key);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("cron:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(normalized);
  return normalizeLowercaseStringOrEmpty(parsed?.rest).startsWith("cron:");
}

export function isDreamingSessionKey(key: string | undefined | null): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(key);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("dreaming-narrative-")) {
    return true;
  }
  const parsed = parseAgentSessionKey(normalized);
  return normalizeLowercaseStringOrEmpty(parsed?.rest).startsWith("dreaming-narrative-");
}

function isMainSessionKey(key: string): boolean {
  if (key === "main") {
    return true;
  }
  const parsed = parseAgentSessionKey(key);
  return parsed?.rest === "main";
}

function isDirectSessionKey(key: string): boolean {
  const parsed = parseAgentSessionKey(key);
  const rest = parsed?.rest ?? key;
  const parts = normalizeLowercaseStringOrEmpty(rest).split(":").filter(Boolean);
  return parts.length >= 3 && parts[1] === "direct";
}

function isGroupSessionKey(key: string): boolean {
  const parsed = parseAgentSessionKey(key);
  const rest = parsed?.rest ?? key;
  const normalized = normalizeLowercaseStringOrEmpty(rest);
  return normalized.includes(":group:") || normalized.includes(":channel:");
}

export function resolveSessionDropdownKind(
  row: Pick<SessionsListResult["sessions"][number], "key" | "kind">,
): SessionDropdownKind {
  if (isCronSessionKey(row.key)) {
    return "cron";
  }
  if (isSubagentSessionKey(row.key)) {
    return "subagent";
  }
  if (isDreamingSessionKey(row.key)) {
    return "dreaming";
  }
  if (row.kind === "group" || isGroupSessionKey(row.key)) {
    return "group";
  }
  if (isMainSessionKey(row.key) || isDirectSessionKey(row.key)) {
    return "main";
  }
  return "other";
}
