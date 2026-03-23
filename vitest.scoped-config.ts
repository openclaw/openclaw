import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

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
    dir?: string;
    exclude?: string[];
    pool?: "threads" | "forks";
    passWithNoTests?: boolean;
  },
) {
  const base = baseConfig as unknown as Record<string, unknown>;
  const baseTest =
    (
      baseConfig as {
        test?: {
          dir?: string;
          exclude?: string[];
          pool?: "threads" | "forks";
          passWithNoTests?: boolean;
        };
      }
    ).test ?? {};
  const exclude = [...(baseTest.exclude ?? []), ...(options?.exclude ?? [])];

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      isolate: resolveVitestIsolation(),
      ...(options?.dir ? { dir: options.dir } : {}),
      include,
      exclude,
      ...(options?.pool ? { pool: options.pool } : {}),
      ...(options?.passWithNoTests !== undefined
        ? { passWithNoTests: options.passWithNoTests }
        : {}),
    },
  });
}
