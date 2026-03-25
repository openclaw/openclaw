import { channelTestInclude } from "./vitest.channel-paths.mjs";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createChannelsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(loadIncludePatternsFromEnv(env) ?? channelTestInclude, {
    env,
    pool: "forks",
    exclude: ["src/gateway/**"],
    passWithNoTests: true,
  });
}

export default createChannelsVitestConfig();
