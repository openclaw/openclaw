import { channelTestInclude } from "./vitest.channel-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createChannelsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(channelTestInclude, {
    env,
    pool: "threads",
    exclude: ["src/gateway/**"],
  });
}

export default createChannelsVitestConfig();
