import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createRuntimeConfigVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/config/**/*.test.ts"], {
    dir: "src",
    env,
    name: "runtime-config",
    passWithNoTests: true,
  });
}

export default createRuntimeConfigVitestConfig();
