import { defineConfig } from "vitest/config";
import { resolveLocalVitestMaxWorkers, sharedVitestConfig } from "./vitest.shared.config.ts";

export { resolveLocalVitestMaxWorkers };

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    projects: [
      "vitest.unit.config.ts",
      "vitest.boundary.config.ts",
      "vitest.acp.config.ts",
      "vitest.ui.config.ts",
    ],
  },
});
