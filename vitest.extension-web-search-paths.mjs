import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const webSearchExtensionIds = [
  "brave",
  "duckduckgo",
  "exa",
  "firecrawl",
  "perplexity",
  "searxng",
  "tavily",
  "yep",
];

export const webSearchExtensionTestRoots = webSearchExtensionIds.map((id) => bundledPluginRoot(id));

export function isWebSearchExtensionRoot(root) {
  return webSearchExtensionTestRoots.includes(root);
}
