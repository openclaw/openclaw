import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createProcessVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/process/**/*.test.ts"], {
    dir: "src",
    env,
    includeOpenClawRuntimeSetup: false,
    name: "process",
    passWithNoTests: true,
  });
}

export default createProcessVitestConfig();
