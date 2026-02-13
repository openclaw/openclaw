import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ?? {};
const include = baseTest.include ?? [
  "src/**/*.test.ts",
  "extensions/**/*.test.ts",
  "test/format-error.test.ts",
];
const extraIncludes = ["ui/src/**/*.node.test.ts"];
const exclude = baseTest.exclude ?? [];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: [...include, ...extraIncludes],
    exclude: [...exclude, "src/gateway/**", "extensions/**"],
  },
});
