import { defineConfig } from "vitest/config";

export { createExtensionZaloUnitVitestConfig as createExtensionZaloVitestConfig } from "./vitest.extension-zalo-unit.config.ts";

export function createExtensionZaloWorkspaceVitestConfig() {
  return defineConfig({
    test: {
      name: "extension-zalo-workspace",
      passWithNoTests: true,
      projects: [
        "vitest.extension-zalo-unit.config.ts",
        "vitest.extension-zalo-lifecycle.config.ts",
      ],
    },
  });
}

export default createExtensionZaloWorkspaceVitestConfig();
