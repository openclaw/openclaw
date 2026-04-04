import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createUtilsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/utils/**/*.test.ts"], {
    dir: "src",
    env,
    name: "utils",
    passWithNoTests: true,
  });
}

export default createUtilsVitestConfig();
