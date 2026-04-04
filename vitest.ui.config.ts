import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";

export function createUiVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["ui/src/ui/**/*.test.ts"], {
    deps: jsdomOptimizedDeps,
    dir: "ui/src/ui",
    environment: "jsdom",
    env,
    includeOpenClawRuntimeSetup: false,
    isolate: true,
    name: "ui",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
  });
}

export default createUiVitestConfig();
