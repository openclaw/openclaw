// Control UI config module wires vitest behavior.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { chromium } from "playwright";
import type { Plugin } from "vite";
import { defineConfig, defineProject, type ViteUserConfig } from "vitest/config";
import type { Vitest } from "vitest/node";
import {
  filterFilesByPatterns,
  intersectIncludePatterns,
} from "../test/vitest/vitest.include-patterns.ts";
import {
  loadPatternListFromEnv,
  matchesVitestGlob,
  relativizeScopedPatterns,
} from "../test/vitest/vitest.pattern-file.ts";
import {
  createVitestProjectCachePlugin,
  loadVitestPerformanceConfig,
} from "../test/vitest/vitest.performance-config.ts";
import { createRedactingReporterPlugin } from "../test/vitest/vitest.reporters.ts";
import {
  jsdomOptimizedDeps,
  nonIsolatedRunnerPath,
  sharedVitestConfig,
} from "../test/vitest/vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "../test/vitest/vitest.ui-isolated-paths.mjs";
import {
  uiNodeDrivenBrowserTestFiles,
  uiTimingTestFiles,
} from "../test/vitest/vitest.ui-paths.mjs";
import { controlUiLocaleModulesPlugin } from "./config/control-ui-locales.ts";
import { UiRuntimePartitionSequencer } from "./test/vitest-runtime-sequencer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const workspaceSourceAliases = [
  {
    find: "@openclaw/gateway-client/browser",
    replacement: path.resolve(repoRoot, "packages/gateway-client/src/browser.ts"),
  },
  {
    find: "@openclaw/gateway-client/scope-upgrade",
    replacement: path.resolve(repoRoot, "packages/gateway-client/src/scope-upgrade.ts"),
  },
  {
    find: /^@openclaw\/gateway-protocol\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/gateway-protocol/src/$1.ts"),
  },
  {
    find: /^@openclaw\/(gateway-protocol|retry)$/u,
    replacement: path.resolve(repoRoot, "packages/$1/src/index.ts"),
  },
  {
    find: "../logging/redact.js",
    replacement: path.resolve(here, "src/lib/browser-redact.ts"),
  },
  ...sharedVitestConfig.resolve.alias.filter(
    (alias) => typeof alias.find === "string" && alias.find.startsWith("openclaw/plugin-sdk/"),
  ),
  {
    find: /^@openclaw\/model-catalog-core\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/model-catalog-core/src/$1.ts"),
  },
  {
    find: "@openclaw/model-catalog-core",
    replacement: path.resolve(repoRoot, "packages/model-catalog-core/src/index.ts"),
  },
  {
    find: /^@openclaw\/normalization-core\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/normalization-core/src/$1"),
  },
  {
    find: "@openclaw/normalization-core",
    replacement: path.resolve(repoRoot, "packages/normalization-core/src/index.ts"),
  },
  {
    find: /^@openclaw\/media-core\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/media-core/src/$1"),
  },
  {
    find: "@openclaw/media-core",
    replacement: path.resolve(repoRoot, "packages/media-core/src/index.ts"),
  },
  {
    find: "@openclaw/session-url-contract/parse",
    replacement: path.resolve(repoRoot, "packages/session-url-contract/src/parse.ts"),
  },
  {
    find: "@openclaw/session-url-contract/share-build",
    replacement: path.resolve(repoRoot, "packages/session-url-contract/src/share-build.ts"),
  },
  {
    find: "@openclaw/session-url-contract/public-share",
    replacement: path.resolve(repoRoot, "packages/session-url-contract/src/public-share.ts"),
  },
  {
    find: "@openclaw/session-url-contract/session-key-normalization",
    replacement: path.resolve(
      repoRoot,
      "packages/session-url-contract/src/session-key-normalization.ts",
    ),
  },
  {
    find: "@openclaw/session-url-contract",
    replacement: path.resolve(repoRoot, "packages/session-url-contract/src/index.ts"),
  },
  {
    find: "@openclaw/workboard-contract",
    replacement: path.resolve(repoRoot, "packages/workboard-contract/src/index.ts"),
  },
  {
    find: /^@openclaw\/net-policy\/(.+)$/u,
    replacement: path.resolve(repoRoot, "packages/net-policy/src/$1"),
  },
  {
    find: "@openclaw/net-policy",
    replacement: path.resolve(repoRoot, "packages/net-policy/src/index.ts"),
  },
];
function includeUiTests(patterns: string[], env = process.env): string[] {
  const selected = intersectIncludePatterns(
    patterns.map((pattern) => path.posix.normalize(`ui/${pattern}`)),
    loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env),
    matchesVitestGlob,
  );
  return selected ? selected.map((pattern) => path.posix.relative("ui", pattern)) : patterns;
}

const sharedUiTestConfig = {
  ...loadVitestPerformanceConfig(process.env, process.platform, here),
  server: sharedVitestConfig.test.server,
  // Preserve calls recorded during shared setup and beforeAll hooks.
  clearMocks: false,
  isolate: false,
  pool: process.versions.bun ? "forks" : "threads",
  // Fresh Bun processes retain the shared source resolver policy.
  ...(process.versions.bun ? { execArgv: sharedVitestConfig.test.execArgv } : {}),
  // Real-Chromium layout tests exceed Vitest's 5s default on 4vcpu CI runners;
  // without this the checks-ui lane flakes on cold hover/interaction tests.
  testTimeout: 60_000,
  hookTimeout: 60_000,
} as const;
const nodeSetupFiles = ["./src/test-helpers/lit-warnings.setup.ts"];
const nodeDrivenBrowserLayoutTests = relativizeScopedPatterns(uiNodeDrivenBrowserTestFiles, "ui");
const timingTests = relativizeScopedPatterns(uiTimingTestFiles, "ui");
const mockRegistryUnitTests = uiIsolatedTestFiles.map((testFile) => testFile.slice("ui/".length));
const chromiumExecutableOverrideEnvKey = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
const systemChromiumExecutableCandidates = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

function canRunChromiumExecutable(executablePath: string): boolean {
  const result = spawnSync(executablePath, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function resolveChromiumLaunchOptions(): { executablePath: string } | undefined {
  const override = process.env[chromiumExecutableOverrideEnvKey]?.trim();
  if (override && existsSync(override) && canRunChromiumExecutable(override)) {
    return { executablePath: override };
  }

  const defaultExecutablePath = chromium.executablePath();
  if (existsSync(defaultExecutablePath) && canRunChromiumExecutable(defaultExecutablePath)) {
    return undefined;
  }

  const systemExecutablePath = systemChromiumExecutableCandidates.find(
    (candidate) => existsSync(candidate) && canRunChromiumExecutable(candidate),
  );
  return systemExecutablePath ? { executablePath: systemExecutablePath } : undefined;
}

let chromiumLaunchOptions: ReturnType<typeof resolveChromiumLaunchOptions> | null = null;

export function createUiBrowserVitestConfig(env = process.env): ViteUserConfig {
  const include = includeUiTests(
    ["src/**/*.browser.test.ts", "../extensions/*/browser/**/*.browser.test.ts"],
    env,
  );
  const runtimeFiles = loadPatternListFromEnv("OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE", env);
  const excludesBrowserFiles =
    runtimeFiles !== null &&
    filterFilesByPatterns(
      runtimeFiles.map((file) => path.posix.relative("ui", file)),
      include,
      nodeDrivenBrowserLayoutTests,
      matchesVitestGlob,
    ).length === 0;
  if (!excludesBrowserFiles && chromiumLaunchOptions === null) {
    chromiumLaunchOptions = resolveChromiumLaunchOptions();
  }
  const provider = playwright({
    launchOptions: {
      ...chromiumLaunchOptions,
      // Keep real canvas encoding without Chromium's idle-task watchdog in test pages.
      args: ["--enable-blink-features=NoIdleEncodingForWebTests"],
    },
  });
  if (excludesBrowserFiles) {
    // Keep browser discovery for native sharding; only skip its speculative launch.
    delete provider.prewarm;
  }
  return defineProject({
    root: here,
    plugins: [
      controlUiLocaleModulesPlugin(),
      createVitestProjectCachePlugin(),
      createRedactingReporterPlugin(),
    ],
    optimizeDeps: {
      include: [
        // These controls share wa-popup's eager registration. Optimize them together
        // so later test imports cannot re-register a rebuilt common chunk.
        // Sidebar fixtures also load lazy dialogs, tabs, and narration. Prepare their
        // dependency graph before tests rather than reloading the active Lit registry.
        "@awesome.me/webawesome/dist/components/dialog/dialog.js",
        "@awesome.me/webawesome/dist/components/tab-group/tab-group.js",
        "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js",
        "@awesome.me/webawesome/dist/components/tab/tab.js",
        "@awesome.me/webawesome/dist/components/dropdown/dropdown.js",
        "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js",
        "@awesome.me/webawesome/dist/components/popover/popover.js",
        "@awesome.me/webawesome/dist/components/popup/popup.js",
        "@lit/context",
        "@lit/task",
        "@noble/ed25519",
        "@noble/hashes/sha2.js",
        "@openclaw/uirouter",
        "dompurify",
        "file-type",
        "highlight.js/lib/core",
        "highlight.js/lib/languages/{bash,cpp,css,diff,java,javascript,json,markdown,python,rust,typescript,xml,yaml}",
        "ipaddr.js",
        "json5",
        "lit/async-directive.js",
        "lit/directive.js",
        "lit/directives/if-defined.js",
        "lit/directives/keyed.js",
        "lit/directives/ref.js",
        "lit/directives/repeat.js",
        "lit/directives/style-map.js",
        "lit/directives/unsafe-html.js",
        "lit/static-html.js",
        "markdown-it",
        "markdown-it-task-lists",
        "mdast-util-from-markdown",
        "mdast-util-gfm-table",
        "micromark-extension-gfm-table",
        "pretty-ms",
        "remend",
        "typebox/compile",
        "typebox/guard",
        "typebox/value",
        "zod",
      ],
    },
    resolve: {
      alias: workspaceSourceAliases,
    },
    test: {
      ...sharedUiTestConfig,
      // File-project loading overrides Vite's root with the config directory.
      // Keep discovery and setup paths rooted in the UI in every entrypoint.
      root: here,
      name: "browser",
      // No cleanup runner: it imports node:fs and repo server modules, which
      // cannot load in browser mode. Browser files own their own teardown.
      include,
      exclude: [...nodeDrivenBrowserLayoutTests],
      setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
      browser: {
        enabled: true,
        provider,
        instances: [{ browser: "chromium", name: "chromium" }],
        headless: true,
        ui: false,
      },
    },
  });
}

function createUiTestSequencerPlugin(): Plugin {
  let partitionedShuffle = false;
  return {
    name: "openclaw:ui-test-sequencer",
    config(config) {
      partitionedShuffle = false;
      const sequence = config.test?.sequence;
      if (sequence?.sequencer) {
        return undefined;
      }
      const shuffleFiles =
        sequence?.shuffle === true ||
        (typeof sequence?.shuffle === "object" && sequence.shuffle.files);
      if (shuffleFiles) {
        partitionedShuffle = Boolean(process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE);
        return undefined;
      }
      return { test: { sequence: { sequencer: UiRuntimePartitionSequencer } } };
    },
    configureServer(server) {
      if (!partitionedShuffle) {
        return;
      }
      // Vitest has now resolved its native random sequencer. Preserve it while
      // applying runtime membership after native sharding and before shuffling.
      const sequence = server.config.test?.sequence;
      if (!sequence || typeof sequence.sequencer !== "function") {
        throw new Error("Vitest did not resolve the UI file-shuffle sequencer");
      }
      const NativeSequencer = sequence.sequencer;
      sequence.sequencer = class extends UiRuntimePartitionSequencer {
        constructor(ctx: Vitest) {
          super(ctx, new NativeSequencer(ctx));
        }
      };
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [
    createVitestProjectCachePlugin(),
    createRedactingReporterPlugin(),
    createUiTestSequencerPlugin(),
  ],
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    ...sharedUiTestConfig,
    maxWorkers: sharedVitestConfig.test.maxWorkers,
    reporters: sharedVitestConfig.test.reporters,
    // These projects already own their complete plugins, aliases, and test config.
    projects: [
      {
        extends: false,
        plugins: [controlUiLocaleModulesPlugin(), createVitestProjectCachePlugin()],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit",
          // isolate:false shares one worker module graph and jsdom window across
          // files, so the first file to evaluate a component owns it for the rest
          // of the worker and a later file's vi.mock never reaches production.
          // The cleanup runner retires that state per file; without it the lane
          // fails whichever sibling the size sequencer happens to pack together.
          runner: nonIsolatedRunnerPath,
          include: includeUiTests(["src/**/*.test.ts", "../extensions/*/browser/**/*.test.ts"]),
          exclude: [
            "src/**/*.browser.test.ts",
            "src/**/*.e2e.test.ts",
            "src/**/*.node.test.ts",
            "../extensions/*/browser/**/*.browser.test.ts",
            "../extensions/*/browser/**/*.e2e.test.ts",
            "../extensions/*/browser/**/*.node.test.ts",
            ...mockRegistryUnitTests,
          ],
          environment: "jsdom",
          setupFiles: nodeSetupFiles,
        },
      },
      {
        extends: false,
        plugins: [controlUiLocaleModulesPlugin(), createVitestProjectCachePlugin()],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          // Reuse the canonical singleton-sensitive list so the package and
          // root runners isolate the same tests without slowing the main suite.
          isolate: true,
          deps: jsdomOptimizedDeps,
          name: "unit-mock-registry",
          include: includeUiTests([...mockRegistryUnitTests]),
          environment: "jsdom",
          setupFiles: nodeSetupFiles,
        },
      },
      {
        extends: false,
        plugins: [controlUiLocaleModulesPlugin(), createVitestProjectCachePlugin()],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit-node",
          exclude: timingTests,
          // No cleanup runner: this project also carries the Playwright-driven
          // layout tests, whose browser lives in module scope. Resetting the
          // module graph between files churns that browser and flakes them.
          include: includeUiTests([
            "src/**/*.node.test.ts",
            "../extensions/*/browser/**/*.node.test.ts",
            ...nodeDrivenBrowserLayoutTests,
          ]),
          environment: "jsdom",
          setupFiles: nodeSetupFiles,
        },
      },
      { ...createUiBrowserVitestConfig(), extends: false },
      {
        extends: false,
        plugins: [controlUiLocaleModulesPlugin(), createVitestProjectCachePlugin()],
        resolve: { alias: workspaceSourceAliases },
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit-timing",
          isolate: true,
          // Finish other UI tests before measuring full-render wall time.
          sequence: { groupOrder: 1 },
          include: includeUiTests(timingTests),
          environment: "jsdom",
          setupFiles: nodeSetupFiles,
        },
      },
    ],
  },
});
