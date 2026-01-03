import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    setupFiles: ["test/setup.ts"],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/vendor/**",
      "dist/Clawdis.app/**",
    ],
  },
});
