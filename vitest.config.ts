import { defineConfig } from "vitest/config";
import {
  resolveDefaultVitestPool,
  resolveLocalVitestMaxWorkers,
  sharedVitestConfig,
} from "./vitest.shared.config.ts";

export { resolveDefaultVitestPool, resolveLocalVitestMaxWorkers };

export const rootVitestProjects = [
  "vitest.unit.config.ts",
  "vitest.infra.config.ts",
  "vitest.boundary.config.ts",
  "vitest.contracts.config.ts",
  "vitest.bundled.config.ts",
  "vitest.gateway.config.ts",
  "vitest.acp.config.ts",
  "vitest.commands.config.ts",
  "vitest.auto-reply.config.ts",
  "vitest.agents.config.ts",
  "vitest.tooling.config.ts",
  "vitest.ui.config.ts",
  "vitest.channels.config.ts",
  "vitest.extension-channels.config.ts",
  "vitest.extension-providers.config.ts",
  "vitest.extensions.config.ts",
] as const;

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    projects: [...rootVitestProjects],
  },
});
