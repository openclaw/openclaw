import fs from "node:fs";
import { channelTestInclude } from "./vitest.channel-paths.mjs";
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

export function createChannelsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(loadIncludePatternsFromEnv(env) ?? channelTestInclude, {
    env,
    pool: "threads",
    exclude: ["src/gateway/**"],
    passWithNoTests: true,
  });
}

export default createChannelsVitestConfig();
