import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createUiVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["ui/src/ui/**/*.test.ts"], {
    dir: "ui/src/ui",
    environment: "jsdom",
    env,
    isolate: true,
    name: "ui",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
    useNonIsolatedRunner: false,
  });
}

export default createUiVitestConfig();
