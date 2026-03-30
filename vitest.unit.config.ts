import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { resolveVitestIsolation } from "./vitest.scoped-config.ts";
import {
	unitTestAdditionalExcludePatterns,
	unitTestIncludePatterns,
} from "./vitest.unit-paths.mjs";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest =
	(baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ??
	{};
const exclude = baseTest.exclude ?? [];

export function loadIncludePatternsFromEnv(
	env: Record<string, string | undefined> = process.env,
): string[] | null {
	return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function loadExtraExcludePatternsFromEnv(
	env: Record<string, string | undefined> = process.env,
): string[] {
	return (
		loadPatternListFromEnv("OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE", env) ?? []
	);
}

export function createUnitVitestConfig(
	env: Record<string, string | undefined> = process.env,
) {
	return defineConfig({
		...base,
		test: {
			...baseTest,
			isolate: resolveVitestIsolation(env),
			runner: "./test/non-isolated-runner.ts",
			include: loadIncludePatternsFromEnv(env) ?? unitTestIncludePatterns,
			exclude: [
				...new Set([
					...exclude,
					...unitTestAdditionalExcludePatterns,
					...loadExtraExcludePatternsFromEnv(env),
				]),
			],
		},
	});
}

export default createUnitVitestConfig();
