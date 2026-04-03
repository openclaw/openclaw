import { defineProject } from "vitest/config";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function loadBoundaryIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createBoundaryVitestConfig(env: Record<string, string | undefined> = process.env) {
  return defineProject({
    ...sharedVitestConfig,
    test: {
      ...sharedVitestConfig.test,
      name: "boundary",
      isolate: false,
      runner: "./test/non-isolated-runner.ts",
      include: loadBoundaryIncludePatternsFromEnv(env) ?? boundaryTestFiles,
      // Boundary workers still need the shared isolated HOME/bootstrap. Only
      // per-file module isolation is disabled here.
      setupFiles: sharedVitestConfig.test.setupFiles,
    },
  });
}

export default createBoundaryVitestConfig();
