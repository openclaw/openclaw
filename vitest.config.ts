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
  "vitest.runtime-config.config.ts",
  "vitest.secrets.config.ts",
  "vitest.cli.config.ts",
  "vitest.commands.config.ts",
  "vitest.auto-reply.config.ts",
  "vitest.agents.config.ts",
  "vitest.daemon.config.ts",
  "vitest.media.config.ts",
  "vitest.plugin-sdk.config.ts",
  "vitest.plugins.config.ts",
  "vitest.cron.config.ts",
  "vitest.media-understanding.config.ts",
  "vitest.shared-core.config.ts",
  "vitest.tooling.config.ts",
  "vitest.ui.config.ts",
  "vitest.channels.config.ts",
  "vitest.extension-acpx.config.ts",
  "vitest.extension-bluebubbles.config.ts",
  "vitest.extension-channels.config.ts",
  "vitest.extension-diffs.config.ts",
  "vitest.extension-matrix.config.ts",
  "vitest.extension-memory.config.ts",
  "vitest.extension-messaging.config.ts",
  "vitest.extension-providers.config.ts",
  "vitest.extension-telegram.config.ts",
  "vitest.extensions.config.ts",
] as const;

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    projects: [...rootVitestProjects],
  },
});
