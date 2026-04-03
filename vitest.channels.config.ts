import { channelTestInclude, extensionRoutedChannelTestFiles } from "./vitest.channel-paths.mjs";
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
    exclude: ["src/gateway/**", ...extensionRoutedChannelTestFiles],
    passWithNoTests: true,
  });
}

export default createChannelsVitestConfig();
