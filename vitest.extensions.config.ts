import { BUNDLED_PLUGIN_TEST_GLOB } from "./scripts/lib/bundled-plugin-paths.mjs";
import { extensionExcludedChannelTestGlobs } from "./vitest.channel-paths.mjs";
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
    // Most channel implementations stay on the channel surface, but a few
    // transport-only suites live better in the general extensions lane.
    exclude: extensionExcludedChannelTestGlobs,
  });
}

export default createExtensionsVitestConfig();
