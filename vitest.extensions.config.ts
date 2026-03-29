import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_TEST_GLOB,
} from "./scripts/lib/bundled-plugin-paths.mjs";
import { channelTestExclude } from "./vitest.channel-paths.mjs";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createExtensionsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(loadIncludePatternsFromEnv(env) ?? [BUNDLED_PLUGIN_TEST_GLOB], {
    dir: "extensions",
    env,
    passWithNoTests: true,
    // Channel implementations live under the bundled plugin tree but are tested by
    // vitest.channels.config.ts (pnpm test:channels) which provides
    // the heavier mock scaffolding they need.
    exclude: channelTestExclude.filter((pattern) => pattern.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)),
  });
}

export default createExtensionsVitestConfig();
