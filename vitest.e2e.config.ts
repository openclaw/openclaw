import os from "node:os";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const cpuCount = os.cpus().length;
// Keep e2e runs deterministic and cheap by default; callers can still override via OPENCLAW_E2E_WORKERS.
const defaultWorkers = isCI ? Math.min(2, Math.max(1, Math.floor(cpuCount * 0.25))) : 1;
const requestedWorkers = Number.parseInt(process.env.OPENCLAW_E2E_WORKERS ?? "", 10);
const e2eWorkers =
  Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? Math.min(16, requestedWorkers)
    : defaultWorkers;
const verboseE2E = process.env.OPENCLAW_E2E_VERBOSE === "1";

const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = (baseTest.exclude ?? []).filter((p) => p !== "**/*.e2e.test.ts");

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    pool: "vmForks",
    maxWorkers: e2eWorkers,
    silent: !verboseE2E,
    include: ["test/**/*.e2e.test.ts"],
    exclude,
  },
});
