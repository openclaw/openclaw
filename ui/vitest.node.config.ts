import { defineConfig } from "vitest/config";

// Node-only tests for pure logic (no Playwright/browser dependency).
export default defineConfig({
  test: {
    include: ["src/**/*.node.test.ts"],
    environment: "node",
  },
});
