export const channelTestRoots = [
  "extensions/telegram",
  "extensions/discord",
  "extensions/whatsapp",
  "extensions/slack",
  "extensions/signal",
  "extensions/imessage",
  "src/browser",
  "src/line",
];

export const channelTestPrefixes = channelTestRoots.map((root) => `${root}/`);
export const channelTestInclude = channelTestRoots.map((root) => `${root}/**/*.test.ts`);
export const channelTestExclude = channelTestRoots.map((root) => `${root}/**`);
