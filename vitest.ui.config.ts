import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createUiVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["ui/src/ui/**/*.test.ts"], {
    dir: "ui/src/ui",
    env,
    name: "ui",
  });
}

export default createUiVitestConfig();
