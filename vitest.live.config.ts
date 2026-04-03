import { defineConfig } from "vitest/config";
import { BUNDLED_PLUGIN_LIVE_TEST_GLOB } from "./scripts/lib/bundled-plugin-paths.mjs";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest =
  (baseConfig as { test?: { exclude?: string[]; setupFiles?: string[] } }).test ?? {};
const exclude = (baseTest.exclude ?? []).filter((p) => p !== "**/*.live.test.ts");

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    // Live suites need immediate provider/gateway progress output rather than
    // Vitest's buffered per-test console capture.
    disableConsoleIntercept: true,
    maxWorkers: 1,
    setupFiles: [...new Set([...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"])],
    include: ["src/**/*.live.test.ts", BUNDLED_PLUGIN_LIVE_TEST_GLOB],
    exclude,
  },
});
