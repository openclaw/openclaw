import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest =
  (
    baseConfig as {
      test?: {
        exclude?: string[];
      };
    }
  ).test ?? {};

export function loadBoundaryIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createBoundaryVitestConfig(env: Record<string, string | undefined> = process.env) {
  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      isolate: false,
      runner: "./test/non-isolated-runner.ts",
      include: loadBoundaryIncludePatternsFromEnv(env) ?? boundaryTestFiles,
      setupFiles: [],
    },
  });
}

export default createBoundaryVitestConfig();
