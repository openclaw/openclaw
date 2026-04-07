import fs from "node:fs";
import path from "node:path";

function normalizeCliPattern(value: string): string {
  let normalized = value
    .trim()
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  if (
    /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(normalized) &&
    !/[?*[\]{}]/u.test(normalized) &&
    !/\.(?:[cm]?[jt]sx?)$/u.test(normalized)
  ) {
    normalized = `${normalized}/**/*.test.*`;
  }
  return normalized;
}

function looksLikeCliIncludePattern(value: string): boolean {
  const normalized = normalizeCliPattern(value);
  return (
    normalized.includes(".test.") ||
    normalized.includes(".e2e.") ||
    normalized.includes(".live.") ||
    /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(normalized)
  );
}

export function loadPatternListFile(filePath: string, label: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${label} must point to a JSON array: ${filePath}`);
  }
  return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function loadPatternListFromEnv(
  envKey: string,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const filePath = env[envKey]?.trim();
  if (!filePath) {
    return null;
  }
  return loadPatternListFile(filePath, envKey);
}

export function loadPatternListFromArgv(argv: string[] = process.argv): string[] | null {
  const patterns = argv
    .slice(2)
    .filter((value) => value !== "run" && value !== "watch" && value !== "bench")
    .filter((value) => !value.startsWith("-"))
    .filter(looksLikeCliIncludePattern)
    .map(normalizeCliPattern);

  return patterns.length > 0 ? [...new Set(patterns)] : null;
}

export function narrowIncludePatternsForCli(
  includePatterns: string[],
  argv: string[] = process.argv,
): string[] | null {
  const cliPatterns = loadPatternListFromArgv(argv);
  if (!cliPatterns) {
    return null;
  }

  const matched = cliPatterns.filter((value) =>
    includePatterns.some(
      (pattern) => path.matchesGlob(value, pattern) || path.matchesGlob(pattern, value),
    ),
  );

  return [...new Set(matched)];
}
