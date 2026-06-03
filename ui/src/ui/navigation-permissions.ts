import { SETTINGS_TABS, TAB_GROUPS, type Tab } from "./navigation.ts";

export type ControlUiOperatorScope =
  | "operator.admin"
  | "operator.read"
  | "operator.write"
  | "operator.approvals"
  | "operator.pairing";

export type ControlUiAuthContext = {
  role?: string | null;
  scopes?: readonly string[] | null;
} | null;

export type TabPermission = {
  readonly scopes?: readonly ControlUiOperatorScope[];
};

export type PermittedTabGroup = {
  readonly label: (typeof TAB_GROUPS)[number]["label"];
  readonly tabs: readonly Tab[];
};

const READ_SCOPES = ["operator.read", "operator.write"] as const;

export const TAB_PERMISSIONS: Readonly<Record<Tab, TabPermission>> = {
  chat: { scopes: READ_SCOPES },
  overview: { scopes: READ_SCOPES },
  instances: { scopes: READ_SCOPES },
  sessions: { scopes: READ_SCOPES },
  usage: { scopes: READ_SCOPES },
  cron: { scopes: READ_SCOPES },
  agents: { scopes: READ_SCOPES },
  skills: { scopes: READ_SCOPES },
  logs: { scopes: READ_SCOPES },
  channels: { scopes: READ_SCOPES },
  communications: { scopes: ["operator.admin"] },
  appearance: { scopes: ["operator.admin"] },
  automation: { scopes: ["operator.admin"] },
  infrastructure: { scopes: ["operator.admin"] },
  aiAgents: { scopes: ["operator.admin"] },
  config: { scopes: ["operator.admin"] },
  debug: { scopes: ["operator.admin"] },
  dreams: { scopes: ["operator.admin"] },
  nodes: { scopes: ["operator.pairing", "operator.admin"] },
};

export function resolveControlUiAuthContext(auth: ControlUiAuthContext): ControlUiAuthContext {
  if (!auth) {
    return null;
  }
  return {
    role: typeof auth.role === "string" ? auth.role : null,
    scopes: Array.isArray(auth.scopes) ? auth.scopes : null,
  };
}

function hasOperatorScope(scopes: readonly string[], scope: ControlUiOperatorScope): boolean {
  if (scopes.includes("operator.admin")) {
    return true;
  }
  if (scope === "operator.read" && scopes.includes("operator.write")) {
    return true;
  }
  return scopes.includes(scope);
}

export function canAccessTab(tab: Tab, auth: ControlUiAuthContext): boolean {
  const context = resolveControlUiAuthContext(auth);
  if (!context) {
    return true;
  }
  if (context.role && context.role !== "operator") {
    return false;
  }
  const scopes = context.scopes ?? [];
  const requiredScopes = TAB_PERMISSIONS[tab]?.scopes ?? [];
  if (requiredScopes.length === 0) {
    return true;
  }
  return requiredScopes.some((scope) => hasOperatorScope(scopes, scope));
}

export function permittedTabs(auth: ControlUiAuthContext): Tab[] {
  const orderedTabs = new Set<Tab>([
    ...(TAB_GROUPS.flatMap((group) => group.tabs) as Tab[]),
    ...SETTINGS_TABS,
  ]);
  return [...orderedTabs].filter((tab) => canAccessTab(tab, auth));
}

export function permittedSettingsTabs(auth: ControlUiAuthContext): Tab[] {
  return SETTINGS_TABS.filter((tab) => canAccessTab(tab, auth));
}

export function permittedTabGroups(auth: ControlUiAuthContext): PermittedTabGroup[] {
  return TAB_GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs.filter((tab) => canAccessTab(tab as Tab, auth)),
  })).filter((group) => group.tabs.length > 0);
}

export function firstPermittedTab(auth: ControlUiAuthContext): Tab | null {
  return permittedTabs(auth)[0] ?? null;
}
