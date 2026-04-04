import path from "node:path";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  bundledPluginRoot,
} from "./scripts/lib/bundled-plugin-paths.mjs";

const normalizeRepoPath = (value) => value.split(path.sep).join("/");

export const extensionRoutedChannelTestFiles = [];

const extensionRoutedChannelTestFileSet = new Set(extensionRoutedChannelTestFiles);

export const channelTestRoots = [
  bundledPluginRoot("discord"),
  bundledPluginRoot("whatsapp"),
  bundledPluginRoot("slack"),
  bundledPluginRoot("signal"),
  bundledPluginRoot("imessage"),
  bundledPluginRoot("browser"),
  bundledPluginRoot("line"),
];

export const extensionChannelTestRoots = channelTestRoots.filter((root) =>
  root.startsWith(BUNDLED_PLUGIN_PATH_PREFIX),
);
export const coreChannelTestRoots = channelTestRoots.filter(
  (root) => !root.startsWith(BUNDLED_PLUGIN_PATH_PREFIX),
);
export const channelTestPrefixes = channelTestRoots.map((root) => `${root}/`);
export const channelTestInclude = channelTestRoots.map((root) => `${root}/**/*.test.ts`);
export const extensionChannelTestInclude = extensionChannelTestRoots.map(
  (root) => `${root}/**/*.test.ts`,
);
export const coreChannelTestInclude = coreChannelTestRoots.map((root) => `${root}/**/*.test.ts`);
export const channelTestExclude = channelTestRoots.map((root) => `${root}/**`);

const extensionChannelRootOverrideBasenames = new Map();
for (const file of extensionRoutedChannelTestFiles) {
  if (!file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    continue;
  }
  const relativeFile = file.slice(BUNDLED_PLUGIN_PATH_PREFIX.length);
  const separator = relativeFile.indexOf("/");
  if (separator === -1) {
    continue;
  }
  const root = relativeFile.slice(0, separator);
  const baseName = path.basename(relativeFile, ".test.ts");
  const current = extensionChannelRootOverrideBasenames.get(root) ?? [];
  current.push(baseName);
  extensionChannelRootOverrideBasenames.set(root, current);
}

export const extensionExcludedChannelTestGlobs = channelTestRoots
  .filter((root) => root.startsWith(BUNDLED_PLUGIN_PATH_PREFIX))
  .map((root) => root.slice(BUNDLED_PLUGIN_PATH_PREFIX.length))
  .map((relativeRoot) => {
    const allowedBasenames = extensionChannelRootOverrideBasenames.get(relativeRoot) ?? [];
    if (allowedBasenames.length === 0) {
      return `${relativeRoot}/**`;
    }
    const alternation = allowedBasenames.join("|");
    return `${relativeRoot}/**/!(${alternation}).test.ts`;
  });

export const extensionChannelOverrideExcludeGlobs = extensionRoutedChannelTestFiles
  .filter((file) => file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX))
  .map((file) => file.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));

export function isChannelSurfaceTestFile(filePath) {
  const normalizedFile = normalizeRepoPath(filePath);
  return (
    channelTestPrefixes.some((prefix) => normalizedFile.startsWith(prefix)) &&
    !extensionRoutedChannelTestFileSet.has(normalizedFile)
  );
}
