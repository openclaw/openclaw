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
  return createScopedVitestConfig(loadIncludePatternsFromEnv(env) ?? ["extensions/**/*.test.ts"], {
    dir: "extensions",
    env,
    pool: "forks",
    passWithNoTests: true,
    // Channel implementations live under extensions/ but are tested by
    // vitest.channels.config.ts (pnpm test:channels) which provides
    // the heavier mock scaffolding they need.
    exclude: channelTestExclude.filter((pattern) => pattern.startsWith("extensions/")),
  });
}

export default createExtensionsVitestConfig();
