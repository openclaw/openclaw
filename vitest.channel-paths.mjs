import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const channelTestRoots = [
  bundledPluginRoot("telegram"),
  bundledPluginRoot("discord"),
  bundledPluginRoot("whatsapp"),
  bundledPluginRoot("slack"),
  bundledPluginRoot("signal"),
  bundledPluginRoot("imessage"),
  "src/browser",
  "src/line",
];

export const channelTestPrefixes = channelTestRoots.map((root) => `${root}/`);
export const channelTestInclude = channelTestRoots.map((root) => `${root}/**/*.test.ts`);
export const channelTestExclude = channelTestRoots.map((root) => `${root}/**`);
