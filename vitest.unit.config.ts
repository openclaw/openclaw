import { defineProject } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { resolveVitestIsolation } from "./vitest.scoped-config.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";
import {
  unitTestAdditionalExcludePatterns,
  unitTestIncludePatterns,
} from "./vitest.unit-paths.mjs";

const sharedTest = sharedVitestConfig.test ?? {};
const exclude = sharedTest.exclude ?? [];

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function loadExtraExcludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return loadPatternListFromEnv("OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE", env) ?? [];
}

export function createUnitVitestConfigWithOptions(
  env: Record<string, string | undefined> = process.env,
  options: {
    includePatterns?: string[];
    extraExcludePatterns?: string[];
    name?: string;
    argv?: string[];
  } = {},
) {
  const isolate = resolveVitestIsolation(env);
  const defaultIncludePatterns = options.includePatterns ?? unitTestIncludePatterns;
  const cliIncludePatterns = narrowIncludePatternsForCli(defaultIncludePatterns, options.argv);
  return defineProject({
    ...sharedVitestConfig,
    test: {
      ...sharedTest,
      name: options.name ?? "unit",
      isolate,
      ...(isolate ? { runner: undefined } : { runner: "./test/non-isolated-runner.ts" }),
      setupFiles: [
        ...new Set([...(sharedTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"]),
      ],
      include: loadIncludePatternsFromEnv(env) ?? cliIncludePatterns ?? defaultIncludePatterns,
      exclude: [
        ...new Set([
          ...exclude,
          ...unitTestAdditionalExcludePatterns,
          ...(options.extraExcludePatterns ?? []),
          ...loadExtraExcludePatternsFromEnv(env),
        ]),
      ],
      ...(cliIncludePatterns !== null ? { passWithNoTests: true } : {}),
    },
  });
}

export function createUnitVitestConfig(env: Record<string, string | undefined> = process.env) {
  return createUnitVitestConfigWithOptions(env);
}

export default createUnitVitestConfigWithOptions();
