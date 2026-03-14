import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ["extensions/**/*.test.ts"],
    exclude: [
      ...(baseTest.exclude ?? []),
      // Channel implementations live under extensions/ but are tested by
      // vitest.channels.config.ts (pnpm test:channels) which provides
      // the heavier mock scaffolding they need.
      "extensions/telegram/**",
      "extensions/discord/**",
      "extensions/whatsapp/**",
      "extensions/slack/**",
      "extensions/signal/**",
      "extensions/imessage/**",
    ],
  },
});
