import { defineConfig } from "vitest/config";
import { narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

function normalizePathPattern(value: string): string {
  return value.replaceAll("\\", "/");
}

function relativizeScopedPattern(value: string, dir: string): string {
  const normalizedValue = normalizePathPattern(value);
  const normalizedDir = normalizePathPattern(dir).replace(/\/+$/u, "");
  if (!normalizedDir) {
    return normalizedValue;
  }
  if (normalizedValue === normalizedDir) {
    return ".";
  }
  const prefix = `${normalizedDir}/`;
  return normalizedValue.startsWith(prefix)
    ? normalizedValue.slice(prefix.length)
    : normalizedValue;
}

function relativizeScopedPatterns(values: string[], dir?: string): string[] {
  if (!dir) {
    return values.map(normalizePathPattern);
  }
  return values.map((value) => relativizeScopedPattern(value, dir));
}

export function resolveVitestIsolation(
  _env: Record<string, string | undefined> = process.env,
): boolean {
  return true;
}

export function createScopedVitestConfig(
  include: string[],
  options?: {
    deps?: Record<string, unknown>;
    dir?: string;
    env?: Record<string, string | undefined>;
    environment?: string;
    exclude?: string[];
    argv?: string[];
    includeOpenClawRuntimeSetup?: boolean;
    isolate?: boolean;
    name?: string;
    pool?: "forks" | "threads";
    passWithNoTests?: boolean;
    setupFiles?: string[];
    useNonIsolatedRunner?: boolean;
  },
) {
  const base = sharedVitestConfig as Record<string, unknown>;
  const baseTest = sharedVitestConfig.test ?? {};
  const scopedDir = options?.dir;
  const cliInclude = narrowIncludePatternsForCli(include, options?.argv);
  const exclude = relativizeScopedPatterns(
    [...(baseTest.exclude ?? []), ...(options?.exclude ?? [])],
    scopedDir,
  );
  const isolate = options?.isolate ?? resolveVitestIsolation(options?.env);
  const setupFiles = [
    ...new Set([
      ...(baseTest.setupFiles ?? []),
      ...(options?.setupFiles ?? []),
      ...(options?.includeOpenClawRuntimeSetup === false ? [] : ["test/setup-openclaw-runtime.ts"]),
    ]),
  ];
  const useNonIsolatedRunner = options?.useNonIsolatedRunner ?? !isolate;

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      ...(options?.deps ? { deps: options.deps } : {}),
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.environment ? { environment: options.environment } : {}),
      isolate,
      ...(useNonIsolatedRunner ? { runner: "./test/non-isolated-runner.ts" } : {}),
      setupFiles,
      ...(scopedDir ? { dir: scopedDir } : {}),
      include: relativizeScopedPatterns(cliInclude ?? include, scopedDir),
      exclude,
      ...(options?.pool ? { pool: options.pool } : {}),
      ...(options?.passWithNoTests !== undefined || cliInclude !== null
        ? { passWithNoTests: options?.passWithNoTests ?? true }
        : {}),
    },
  });
}
