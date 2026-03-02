import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: [
      "src/telegram/**/*.test.ts",
      "src/discord/**/*.test.ts",
      "src/web/**/*.test.ts",
      "src/browser/**/*.test.ts",
      "src/line/**/*.test.ts",
    ],
    exclude: [...(baseTest.exclude ?? []), "src/gateway/**", "extensions/**"],
  },
});
