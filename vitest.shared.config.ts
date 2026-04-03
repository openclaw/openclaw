import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginSdkSubpaths } from "./scripts/lib/plugin-sdk-entries.mjs";
import {
  BUNDLED_PLUGIN_ROOT_DIR,
  BUNDLED_PLUGIN_TEST_GLOB,
} from "./vitest.bundled-plugin-paths.ts";
import { loadVitestExperimentalConfig } from "./vitest.performance-config.ts";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type VitestHostInfo = {
  cpuCount?: number;
  totalMemoryBytes?: number;
};

function detectVitestHostInfo(): Required<VitestHostInfo> {
  return {
    cpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
}

export function resolveLocalVitestMaxWorkers(
  env: Record<string, string | undefined> = process.env,
  system: VitestHostInfo = detectVitestHostInfo(),
): number {
  const override = parsePositiveInt(env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS);
  if (override !== null) {
    return clamp(override, 1, 16);
  }

  const cpuCount = Math.max(1, system.cpuCount ?? 1);
  const totalMemoryGb = (system.totalMemoryBytes ?? 0) / 1024 ** 3;

  let inferred = cpuCount <= 4 ? cpuCount - 1 : Math.floor(cpuCount / 2);
  inferred = clamp(inferred, 1, 8);

  if (totalMemoryGb <= 16) {
    return Math.min(inferred, 2);
  }
  if (totalMemoryGb <= 32) {
    return Math.min(inferred, 3);
  }
  if (totalMemoryGb <= 64) {
    return Math.min(inferred, 4);
  }
  return Math.min(inferred, 8);
}

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isWindows = process.platform === "win32";
const localWorkers = resolveLocalVitestMaxWorkers();
const ciWorkers = isWindows ? 2 : 3;

export const sharedVitestConfig = {
  resolve: {
    alias: [
      {
        find: "openclaw/extension-api",
        replacement: path.join(repoRoot, "src", "extensionAPI.ts"),
      },
      ...pluginSdkSubpaths.map((subpath) => ({
        find: `openclaw/plugin-sdk/${subpath}`,
        replacement: path.join(repoRoot, "src", "plugin-sdk", `${subpath}.ts`),
      })),
      {
        find: "openclaw/plugin-sdk",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
      },
    ],
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: isWindows ? 180_000 : 120_000,
    unstubEnvs: true,
    unstubGlobals: true,
    pool: "forks" as const,
    maxWorkers: isCI ? ciWorkers : localWorkers,
    forceRerunTriggers: [
      "package.json",
      "pnpm-lock.yaml",
      "test/setup.ts",
      "test/setup.shared.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
      "scripts/test-projects.mjs",
      "vitest.channel-paths.mjs",
      "vitest.channels.config.ts",
      "vitest.boundary.config.ts",
      "vitest.bundled.config.ts",
      "vitest.config.ts",
      "vitest.contracts.config.ts",
      "vitest.e2e.config.ts",
      "vitest.extensions.config.ts",
      "vitest.gateway.config.ts",
      "vitest.live.config.ts",
      "vitest.performance-config.ts",
      "vitest.scoped-config.ts",
      "vitest.shared.config.ts",
      "vitest.unit.config.ts",
      "vitest.unit-paths.mjs",
    ],
    include: [
      "src/**/*.test.ts",
      BUNDLED_PLUGIN_TEST_GLOB,
      "packages/**/*.test.ts",
      "test/**/*.test.ts",
      "ui/src/ui/app-chat.test.ts",
      "ui/src/ui/chat/**/*.test.ts",
      "ui/src/ui/views/agents-utils.test.ts",
      "ui/src/ui/views/channels.test.ts",
      "ui/src/ui/views/chat.test.ts",
      "ui/src/ui/views/nodes.devices.test.ts",
      "ui/src/ui/views/skills.test.ts",
      "ui/src/ui/views/usage-render-details.test.ts",
      "ui/src/ui/controllers/agents.test.ts",
      "ui/src/ui/controllers/chat.test.ts",
      "ui/src/ui/controllers/skills.test.ts",
      "ui/src/ui/controllers/sessions.test.ts",
      "ui/src/ui/views/sessions.test.ts",
      "ui/src/ui/app-tool-stream.node.test.ts",
      "ui/src/ui/app-gateway.sessions.node.test.ts",
      "ui/src/ui/chat/slash-command-executor.node.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
    exclude: [
      "dist/**",
      "test/fixtures/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/OpenClaw.app/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
    coverage: {
      provider: "v8" as const,
      reporter: ["text", "lcov"],
      all: false,
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
      include: ["./src/**/*.ts"],
      exclude: [
        `${BUNDLED_PLUGIN_ROOT_DIR}/**`,
        "apps/**",
        "ui/**",
        "test/**",
        "src/**/*.test.ts",
        "src/entry.ts",
        "src/index.ts",
        "src/runtime.ts",
        "src/channel-web.ts",
        "src/logging.ts",
        "src/cli/**",
        "src/commands/**",
        "src/daemon/**",
        "src/hooks/**",
        "src/macos/**",
        "src/acp/**",
        "src/agents/**",
        "src/channels/**",
        "src/gateway/**",
        "src/line/**",
        "src/media-understanding/**",
        "src/node-host/**",
        "src/plugins/**",
        "src/providers/**",
        "src/agents/model-scan.ts",
        "src/agents/pi-embedded-runner.ts",
        "src/agents/sandbox-paths.ts",
        "src/agents/sandbox.ts",
        "src/agents/skills-install.ts",
        "src/agents/pi-tool-definition-adapter.ts",
        "src/agents/tools/discord-actions*.ts",
        "src/agents/tools/slack-actions.ts",
        "src/infra/state-migrations.ts",
        "src/infra/skills-remote.ts",
        "src/infra/update-check.ts",
        "src/infra/ports-inspect.ts",
        "src/infra/outbound/outbound-session.ts",
        "src/memory/batch-gemini.ts",
        "src/gateway/control-ui.ts",
        "src/gateway/server-bridge.ts",
        "src/gateway/server-channels.ts",
        "src/gateway/server-methods/config.ts",
        "src/gateway/server-methods/send.ts",
        "src/gateway/server-methods/skills.ts",
        "src/gateway/server-methods/talk.ts",
        "src/gateway/server-methods/web.ts",
        "src/gateway/server-methods/wizard.ts",
        "src/gateway/call.ts",
        "src/process/tau-rpc.ts",
        "src/process/exec.ts",
        "src/tui/**",
        "src/wizard/**",
        "src/browser/**",
        "src/channels/web/**",
        "src/webchat/**",
        "src/gateway/server.ts",
        "src/gateway/client.ts",
        "src/gateway/protocol/**",
        "src/infra/tailscale.ts",
      ],
    },
    ...loadVitestExperimentalConfig(),
  },
};
