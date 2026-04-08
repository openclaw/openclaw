import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const qaToolsExtensionIds = ["qa-channel", "qa-lab"];

export const qaToolsExtensionTestRoots = qaToolsExtensionIds.map((id) => bundledPluginRoot(id));

export function isQaToolsExtensionRoot(root) {
  return qaToolsExtensionTestRoots.includes(root);
}
