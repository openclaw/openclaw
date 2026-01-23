import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ?? {};
const include = baseTest.include ?? [
  "src/**/*.test.ts",
  "extensions/**/*.test.ts",
  "test/format-error.test.ts",
];
const exclude = baseTest.exclude ?? [];

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include,
      exclude: [...exclude, "src/gateway/**", "extensions/**"],
    },
  }),
);
