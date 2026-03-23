import { channelTestInclude } from "./vitest.channel-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(channelTestInclude, {
  pool: "threads",
  exclude: ["src/gateway/**"],
});
