import { defineConfig } from "vitest/config";

/**
 * Minimal config for `session-tool-kind` unit tests only (avoids full-repo test discovery).
 * Run: `pnpm exec vitest run --config vitest.session-tool-kind.config.ts`
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/gateway/session-tool-kind.test.ts"],
    passWithNoTests: false,
  },
});
