export const TAB_GROUPS = [
  { label: "Chat", tabs: ["chat"] },
  {
    label: "Control",
    tabs: ["overview", "connections", "instances", "sessions", "cron"],
  },
  { label: "Agent", tabs: ["skills", "nodes"] },
  { label: "Settings", tabs: ["config", "debug"] },
] as const;

export type Tab =
  | "overview"
  | "connections"
  | "instances"
  | "sessions"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "debug";

export function titleForTab(tab: Tab) {
  switch (tab) {
    case "overview":
      return "Overview";
    case "connections":
      return "Connections";
    case "instances":
      return "Instances";
    case "sessions":
      return "Sessions";
    case "cron":
      return "Cron Jobs";
    case "skills":
      return "Skills";
    case "nodes":
      return "Nodes";
    case "chat":
      return "Chat";
    case "config":
      return "Config";
    case "debug":
      return "Debug";
    default:
      return "Control";
  }
}

export function subtitleForTab(tab: Tab) {
  switch (tab) {
    case "overview":
      return "Gateway status, entry points, and a fast health read.";
    case "connections":
      return "Link providers and keep transport settings in sync.";
    case "instances":
      return "Presence beacons from connected clients and nodes.";
    case "sessions":
      return "Inspect active sessions and adjust per-session defaults.";
    case "cron":
      return "Schedule wakeups and recurring agent runs.";
    case "skills":
      return "Manage skill availability and API key injection.";
    case "nodes":
      return "Paired devices, capabilities, and command exposure.";
    case "chat":
      return "Direct gateway chat session for quick interventions.";
    case "config":
      return "Edit ~/.clawdis/clawdis.json safely.";
    case "debug":
      return "Gateway snapshots, events, and manual RPC calls.";
    default:
      return "";
  }
}
