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
function loadPatternListFile(filePath: string, label: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${label} must point to a JSON array: ${filePath}`);
  }
  return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const includeFile = env.OPENCLAW_VITEST_INCLUDE_FILE?.trim();
  if (!includeFile) {
    return null;
  }
  return loadPatternListFile(includeFile, "OPENCLAW_VITEST_INCLUDE_FILE");
}

export function loadExtraExcludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const extraExcludeFile = env.OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE?.trim();
  if (!extraExcludeFile) {
    return [];
  }
  return loadPatternListFile(extraExcludeFile, "OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE");
}

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: loadIncludePatternsFromEnv() ?? unitTestIncludePatterns,
    exclude: [
      ...new Set([
        ...exclude,
        ...unitTestAdditionalExcludePatterns,
        ...loadExtraExcludePatternsFromEnv(),
      ]),
    ],
  },
});
