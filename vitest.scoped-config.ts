import { defineConfig } from "vitest/config";
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
  env: Record<string, string | undefined> = process.env,
): boolean {
  const forceIsolation = env.OPENCLAW_TEST_ISOLATE === "1" || env.OPENCLAW_TEST_ISOLATE === "true";
  if (forceIsolation) {
    return true;
  }
  return env.OPENCLAW_TEST_NO_ISOLATE === "0" || env.OPENCLAW_TEST_NO_ISOLATE === "false";
}

export function createScopedVitestConfig(
  include: string[],
  options?: {
    deps?: Record<string, unknown>;
    dir?: string;
    env?: Record<string, string | undefined>;
    environment?: string;
    exclude?: string[];
    includeOpenClawRuntimeSetup?: boolean;
    isolate?: boolean;
    name?: string;
    pool?: "forks";
    passWithNoTests?: boolean;
    setupFiles?: string[];
    useNonIsolatedRunner?: boolean;
  },
) {
  const base = sharedVitestConfig as Record<string, unknown>;
  const baseTest = sharedVitestConfig.test ?? {};
  const scopedDir = options?.dir;
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
      include: relativizeScopedPatterns(include, scopedDir),
      exclude,
      ...(options?.pool ? { pool: options.pool } : {}),
      ...(options?.passWithNoTests !== undefined
        ? { passWithNoTests: options.passWithNoTests }
        : {}),
    },
  });
}
