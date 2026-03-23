import fs from "node:fs";
import { channelTestExclude } from "./vitest.channel-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

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

export default createScopedVitestConfig(
  loadIncludePatternsFromEnv() ?? ["extensions/**/*.test.ts"],
  {
    dir: "extensions",
    pool: "threads",
    // Channel implementations live under extensions/ but are tested by
    // vitest.channels.config.ts (pnpm test:channels) which provides
    // the heavier mock scaffolding they need.
    exclude: channelTestExclude.filter((pattern) => pattern.startsWith("extensions/")),
  },
);
