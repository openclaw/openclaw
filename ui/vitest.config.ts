import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-utils/vitest.setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    browser: {
      enabled: true,
      provider: playwright({
        contextOptions: {
          timezoneId: "UTC",
        },
      }),
      instances: [{ browser: "chromium", name: "chromium" }],
      headless: true,
      ui: false,
    },
  },
});
