import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = baseTest.exclude ?? [];

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ["extensions/**/*.test.ts"],
    exclude,
    // Use absolute path for setup file to avoid path resolution issues
    setupFiles: [path.join(repoRoot, "test", "setup.ts")],
  },
});
