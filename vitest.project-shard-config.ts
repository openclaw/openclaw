import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

export function createProjectShardVitestConfig(projects: readonly string[]) {
  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedVitestConfig.test,
      runner: "./test/non-isolated-runner.ts",
      projects: [...projects],
    },
  });
}
