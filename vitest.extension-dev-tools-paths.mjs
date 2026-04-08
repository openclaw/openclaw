import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const devToolsExtensionIds = [
  "arcee",
  "device-pair",
  "diagnostics-otel",
  "kilocode",
  "litellm",
  "llm-task",
  "lobster",
  "opencode",
  "opencode-go",
  "openshell",
  "phone-control",
  "synthetic",
  "thread-ownership",
  "vercel-ai-gateway",
  "webhooks",
  "xiaomi",
];

export const devToolsExtensionTestRoots = devToolsExtensionIds.map((id) => bundledPluginRoot(id));

export function isDevToolsExtensionRoot(root) {
  return devToolsExtensionTestRoots.includes(root);
}
