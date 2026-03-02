import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

export function createScopedVitestConfig(include: string[]) {
  const base = baseConfig as unknown as Record<string, unknown>;
  const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
  const exclude = baseTest.exclude ?? [];

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      include,
      exclude,
    },
  });
}
