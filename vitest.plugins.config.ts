import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createPluginsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/plugins/**/*.test.ts"], {
    dir: "src/plugins",
    env,
    isolate: true,
    name: "plugins",
    passWithNoTests: true,
  });
}

export default createPluginsVitestConfig();
