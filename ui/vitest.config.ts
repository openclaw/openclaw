import { playwright } from "@vitest/browser-playwright";
import { defineConfig, defineProject } from "vitest/config";
import { jsdomOptimizedDeps } from "../vitest.shared.config.ts";

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          deps: jsdomOptimizedDeps,
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts", "src/**/*.node.test.ts"],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        test: {
          deps: jsdomOptimizedDeps,
          name: "unit-node",
          include: ["src/**/*.node.test.ts"],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium", name: "chromium" }],
            headless: true,
            ui: false,
          },
        },
      }),
    ],
  },
});
