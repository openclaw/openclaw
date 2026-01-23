import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = baseTest.exclude ?? [];

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["src/gateway/**/*.test.ts", "extensions/**/*.test.ts"],
      exclude,
    },
  }),
);
