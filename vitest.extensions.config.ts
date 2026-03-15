import { channelTestExclude } from "./vitest.channel-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(["extensions/**/*.test.ts"], {
  // Channel implementations live under extensions/ but are tested by
  // vitest.channels.config.ts (pnpm test:channels) which provides
  // the heavier mock scaffolding they need.
  exclude: channelTestExclude.filter((pattern) => pattern.startsWith("extensions/")),
});
