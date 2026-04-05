import { defineConfig } from "vitest/config";
import { resolveDefaultVitestPool } from "../vitest.shared.config.ts";

// Node-only tests for pure logic (no Playwright/browser dependency).
export default defineConfig({
  test: {
    isolate: false,
    pool: resolveDefaultVitestPool(),
    runner: "../test/non-isolated-runner.ts",
    testTimeout: 120_000,
    include: ["src/**/*.node.test.ts"],
    environment: "node",
  },
});
