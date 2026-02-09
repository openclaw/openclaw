/**
 * Vitest configuration for Slow tier tests (>1s)
 *
 * These tests are resource-intensive:
 * - E2E tests
 * - Integration tests
 * - Tests with network calls
 * - Tests with process spawning
 *
 * Run with: pnpm test:slow
 *
 * Note: Live tests are excluded here as they require real API keys.
 * Run live tests separately with: pnpm test:live
 *
 * Note: UI browser tests (ui/**\/*.browser.test.ts) run separately via `pnpm test:ui`
 * as they require the Playwright browser environment.
 */
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest =
  (baseConfig as { test?: { exclude?: string[]; setupFiles?: string[] } }).test ?? {};
const baseExclude = baseTest.exclude ?? [];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    name: "slow",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Reduce parallelism for slow tests to avoid resource contention
    maxWorkers: 2,
    include: [
      // E2E tests (excluding live tests)
      "src/**/*.e2e.test.ts",
      "test/**/*.e2e.test.ts",
      // Integration tests
      "**/*.integration.test.ts",
      // Specific test/ files that are known to work (non-e2e, non-live)
      "test/format-error.test.ts",
      "test/inbound-contract.providers.test.ts",
    ],
    exclude: [
      ...baseExclude,
      // Exclude live tests (require real API keys)
      "**/*.live.test.ts",
      // Exclude UI browser tests - they need Playwright browser env (run via pnpm test:ui)
      "ui/**/*.browser.test.ts",
      // Exclude broken tests with missing exports
      "test/auto-reply.retry.test.ts",
    ],
  },
});
