const normalizeRepoPath = (value) => value.replaceAll("\\", "/");

export const pluginSdkLightTestFiles = [
  "src/plugin-sdk/acp-runtime.test.ts",
  "src/plugin-sdk/provider-entry.test.ts",
  "src/plugin-sdk/runtime.test.ts",
  "src/plugin-sdk/temp-path.test.ts",
  "src/plugin-sdk/text-chunking.test.ts",
  "src/plugin-sdk/webhook-targets.test.ts",
];

export function isPluginSdkLightTestFile(file) {
  return pluginSdkLightTestFiles.includes(normalizeRepoPath(file));
}
