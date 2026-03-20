import fs from "node:fs";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";
import {
  unitTestAdditionalExcludePatterns,
  unitTestIncludePatterns,
} from "./vitest.unit-paths.mjs";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ?? {};
const exclude = baseTest.exclude ?? [];
export function loadExtraExcludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const extraExcludeFile = env.OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE?.trim();
  if (!extraExcludeFile) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(extraExcludeFile, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE must point to a JSON array: ${extraExcludeFile}`,
    );
  }
  return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: unitTestIncludePatterns,
    exclude: [
      ...new Set([
        ...exclude,
        ...unitTestAdditionalExcludePatterns,
        ...loadExtraExcludePatternsFromEnv(),
      ]),
    ],
  },
});
