import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/format-error.test.ts"],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/vendor/**",
      "dist/Clawdis.app/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // CLI wiring and process bridges are exercised via e2e/manual flows; they are hard to unit-test in isolation.
        "src/cli/program.ts",
        "src/gateway/call.ts",
        "src/process/tau-rpc.ts",
        "src/process/exec.ts",
        "src/providers/web/**",
        "src/telegram/index.ts",
        "src/telegram/proxy.ts",
        "src/telegram/webhook-set.ts",
        "src/telegram/**",
        "src/webchat/**",
        "src/gateway/server.ts",
        "src/gateway/client.ts",
        "src/gateway/protocol/**",
        "src/infra/tailscale.ts",
      ],
    },
  },
});
