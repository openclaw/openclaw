// Control UI config module wires vitest behavior.
import { defineConfig } from "vitest/config";
import { createRedactingReporterPlugin } from "../test/vitest/vitest.reporters.ts";
import { sharedVitestConfig } from "../test/vitest/vitest.shared.config.ts";
import { controlUiLocaleModulesPlugin } from "./config/control-ui-locales.ts";
import { controlUiSolidPlugin } from "./vite.config.ts";

// Node-only tests for pure logic (no Playwright/browser dependency).
export default defineConfig({
  plugins: [
    controlUiLocaleModulesPlugin(),
    createRedactingReporterPlugin(),
    controlUiSolidPlugin(),
  ],
  test: {
    reporters: sharedVitestConfig.test.reporters,
    clearMocks: false,
    isolate: false,
    pool: "threads",
    testTimeout: 120_000,
    include: [
      "src/**/*.node.test.{ts,tsx}",
      "src/pages/chat/chat-responsive.browser.test.{ts,tsx}",
      "src/pages/chat/chat-footer-layout.browser.test.{ts,tsx}",
    ],
    environment: "node",
  },
});
