import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

export function createScopedVitestConfig(
  include: string[],
  options?: { exclude?: string[]; pool?: "threads" | "forks" | "vmForks" },
) {
  const base = baseConfig as unknown as Record<string, unknown>;
  const baseTest =
    (baseConfig as { test?: { exclude?: string[]; pool?: "threads" | "forks" | "vmForks" } })
      .test ?? {};
  const exclude = [...(baseTest.exclude ?? []), ...(options?.exclude ?? [])];

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      include,
      exclude,
      ...(options?.pool ? { pool: options.pool } : {}),
    },
  });
}
