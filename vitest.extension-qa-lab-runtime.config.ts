import { qaLabRuntimeTestFiles } from "./vitest.extension-qa-lab-paths.mjs";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createExtensionQaLabRuntimeVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(loadIncludePatternsFromEnv(env) ?? qaLabRuntimeTestFiles, {
    dir: "extensions",
    env,
    name: "extension-qa-lab-runtime",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  });
}

export default createExtensionQaLabRuntimeVitestConfig();
