import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const baseSetup = Array.isArray(baseTest.setupFiles) ? baseTest.setupFiles : [];
const exclude = (baseTest.exclude ?? []).filter((p) => p !== "**/*.live.test.ts");

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    setupFiles: [...baseSetup, "test/setup-live-env.ts"],
    maxWorkers: 1,
    include: ["src/**/*.live.test.ts"],
    exclude,
    reporters: ["./src/test-utils/live-test-reporter.ts"],
    testTimeout: 30_000,
  },
});
