import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ?? {};
const baseInclude = baseTest.include ?? [
  "src/**/*.test.ts",
  "extensions/**/*.test.ts",
  "test/format-error.test.ts",
];
const include = [...baseInclude, "skills/text2sql/**/*.test.ts"];
const exclude = baseTest.exclude ?? [];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include,
    exclude: [...exclude, "src/gateway/**", "extensions/**"],
  },
});
