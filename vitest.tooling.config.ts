import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createToolingVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    loadIncludePatternsFromEnv(env) ?? [
      "test/**/*.test.ts",
      "src/scripts/**/*.test.ts",
      "src/config/doc-baseline.integration.test.ts",
      "src/config/schema.base.generated.test.ts",
      "src/config/schema.help.quality.test.ts",
    ],
    {
      env,
      name: "tooling",
      passWithNoTests: true,
    },
  );
}

export default createToolingVitestConfig();
