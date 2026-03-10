import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// `@vitest/browser-playwright` can resolve its peer `vitest` through a different
// package instance than `defineConfig()` in monorepo type-aware checks.
const browserProvider = playwright() as never;

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: browserProvider,
      instances: [{ browser: "chromium", name: "chromium" }],
      headless: true,
      ui: false,
    },
  },
});
