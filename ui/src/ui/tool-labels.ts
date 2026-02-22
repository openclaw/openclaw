/**
 * Map raw tool names to human-friendly labels for the chat UI.
 * Unknown tools are title-cased with underscores replaced by spaces.
 */

export const TOOL_LABELS: Record<string, string> = {
  exec: "Run Command",
  bash: "Run Command",
  read: "Read File",
  write: "Write File",
  edit: "Edit File",
  apply_patch: "Apply Patch",
  web_search: "Web Search",
  web_fetch: "Fetch Page",
  browser: "Browser",
  message: "Send Message",
  image: "Generate Image",
  canvas: "Canvas",
  cron: "Cron",
  gateway: "Gateway",
  nodes: "Nodes",
  memory_search: "Search Memory",
  memory_get: "Get Memory",
  session_status: "Session Status",
  sessions_list: "List Sessions",
  sessions_history: "Session History",
  sessions_send: "Send to Session",
  sessions_spawn: "Spawn Session",
  agents_list: "List Agents",
};

export function friendlyToolName(raw: string): string {
  const mapped = TOOL_LABELS[raw];
  if (mapped) {
    return mapped;
  }
  // Title-case fallback: "some_tool_name" → "Some Tool Name"
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
