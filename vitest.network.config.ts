import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = baseTest.exclude ?? [];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: [
      "src/browser/cdp.test.ts",
      "src/canvas-host/server.test.ts",
      "src/commands/chutes-oauth.test.ts",
      "src/infra/ports.test.ts",
      "src/process/child-process-bridge.test.ts",
      "src/telegram/webhook.test.ts",
    ],
    exclude,
  },
});
