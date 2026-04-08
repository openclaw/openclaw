import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

export function createProjectShardVitestConfig(projects: readonly string[]) {
  const maxWorkers = sharedVitestConfig.test.maxWorkers;
  if (!process.env.OPENCLAW_VITEST_MAX_WORKERS && typeof maxWorkers === "number") {
    process.env.OPENCLAW_VITEST_MAX_WORKERS = String(maxWorkers);
  }
  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedVitestConfig.test,
      runner: "./test/non-isolated-runner.ts",
      projects: [...projects],
    },
  });
}
