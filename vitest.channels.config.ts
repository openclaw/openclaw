import { channelTestInclude } from "./vitest.channel-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(channelTestInclude, {
  exclude: ["src/gateway/**"],
});
