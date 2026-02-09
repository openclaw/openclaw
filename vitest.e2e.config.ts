import os from "node:os";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const cpuCount = os.cpus().length;
const e2eWorkers = isCI ? 2 : Math.min(4, Math.max(1, Math.floor(cpuCount * 0.25)));

const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = (baseTest.exclude ?? []).filter((p) => p !== "**/*.e2e.test.ts");

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    maxWorkers: e2eWorkers,
    include: ["test/**/*.e2e.test.ts", "src/**/*.e2e.test.ts"],
    exclude,
  },
});
