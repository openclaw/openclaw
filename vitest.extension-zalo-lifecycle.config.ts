import { zaloLifecycleTestFiles } from "./vitest.extension-zalo-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionZaloLifecycleVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(zaloLifecycleTestFiles, {
    dir: "extensions",
    env,
    isolate: true,
    name: "extension-zalo-lifecycle",
    passWithNoTests: true,
    pool: "forks",
    setupFiles: ["test/setup.extensions.ts"],
    useNonIsolatedRunner: false,
  });
}

export default createExtensionZaloLifecycleVitestConfig();
