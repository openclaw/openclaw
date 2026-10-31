// Control UI config module wires vitest behavior.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { chromium } from "playwright";
import type { Plugin } from "vite";
import { defineConfig, defineProject, type ViteUserConfig } from "vitest/config";
import type { Vitest } from "vitest/node";
import { peleClassicBundlePlugin } from "../packages/mermaid-renderer/vite-plugin.ts";
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
import { nonIsolatedRunnerPath, sharedVitestConfig } from "../test/vitest/vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "../test/vitest/vitest.ui-isolated-paths.mjs";
import {
  resolveUiTypeScriptPath,
  uiNodeDrivenBrowserTestFiles,
  uiTimingTestFiles,
} from "../test/vitest/vitest.ui-paths.mjs";
import { controlUiLocaleModulesPlugin } from "./config/control-ui-locales.ts";
import { controlUiSolidPlugin } from "./config/control-ui-solid.ts";
import { resolvePlaywrightChromiumExecutablePath } from "./src/test-helpers/playwright-chromium.ts";
import { overlayEmulateMedia } from "./test/overlay-browser-commands.ts";
import { UiRuntimePartitionSequencer } from "./test/vitest-runtime-sequencer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const workspaceSourceAliases = [
  {
    find: "../logging/redact.js",
    replacement: path.resolve(here, "src/lib/browser-redact.ts"),
  },
  // Share package source projections without pulling Node-only dependency shims
  // (such as zod and ws) into the browser projects.
  ...sharedVitestConfig.resolve.alias.filter(
    (alias) =>
      alias.replacement.startsWith(`${path.join(repoRoot, "packages")}${path.sep}`) ||
      (typeof alias.find === "string" && alias.find.startsWith("openclaw/plugin-sdk/")),
  ),
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
  // Initialize jsdom compatibility before either native worker pool starts.
  execArgv: sharedVitestConfig.test.execArgv,
  // Real-Chromium layout tests exceed Vitest's 5s default on 4vcpu CI runners;
  // without this the checks-ui lane flakes on cold hover/interaction tests.
  testTimeout: 60_000,
  hookTimeout: 60_000,
} as const;
const nodeSetupFiles = ["./src/test-helpers/dom.setup.ts"];
const nodeDrivenBrowserLayoutTests = relativizeScopedPatterns(uiNodeDrivenBrowserTestFiles, "ui");
const timingTests = relativizeScopedPatterns(uiTimingTestFiles, "ui");
const mockRegistryUnitTests = uiIsolatedTestFiles.map((testFile) => testFile.slice("ui/".length));
function resolveChromiumLaunchOptions(): { executablePath: string } | undefined {
  const defaultExecutablePath = chromium.executablePath();
  const executablePath = resolvePlaywrightChromiumExecutablePath(defaultExecutablePath);
  // Playwright picks its own headless shell for the pinned default; pin only alternatives.
  return executablePath === defaultExecutablePath ? undefined : { executablePath };
}

let chromiumLaunchOptions: ReturnType<typeof resolveChromiumLaunchOptions> | null = null;

// The accessibility-tree suite remains Chromium-only until its CDP probe is replaced.
const webkitTestFiles = [
  "src/pages/config/view.config-read.browser.test.tsx",
  "src/pages/usage/view-details.browser.test.tsx",
  "src/components/settings-ui.browser.test.tsx",
  "src/components/select-picker.behavior.browser.test.ts",
  "src/components/select-picker.browser.test.tsx",
  "src/components/multi-select.browser.test.ts",
  "src/components/model-picker.browser.test.ts",
  "src/components/decision-model-picker.browser.test.tsx",
  "src/components/agent-select-opening.browser.test.ts",
  "src/components/app-sidebar-agent-menu-scroll.browser.test.ts",
  "src/components/app-sidebar-rail-menus.browser.test.ts",
  "src/components/app-sidebar-session-visibility.browser.test.ts",
  "src/components/app-sidebar-owner-avatar.browser.test.ts",
  "src/components/agent-emoji-picker.browser.test.ts",
  "src/components/appearance-picker.browser.test.ts",
  "src/components/confirm-dialog.browser.test.ts",
  "src/pages/channels/view.detail.browser.test.tsx",
  "src/pages/plugins/settings-lifecycle.browser.test.tsx",
  "src/pages/new-session/project-chip.registration.browser.test.tsx",
  "src/pages/agents/agent-file-preview.browser.test.ts",
  "src/pages/skills/reader-shell.browser.test.tsx",
  "src/lib/toast.browser.test.ts",
  "src/components/session-menu.browser.test.ts",
  "src/components/session-people-search.browser.test.ts",
  "src/components/control-theme.browser.test.tsx",
  "src/components/menu-surface.browser.test.tsx",
  "src/components/session-progress-hovercard.browser.test.ts",
  "src/components/modal-dialog.test.ts",
  "src/components/tooltip.test.ts",
  "src/components/tooltip.browser.test.ts",
  "src/components/tooltip.escape-hover.browser.test.ts",
  "src/components/panel-tab-strip.test.ts",
  "src/components/panel-tab-strip.browser.test.ts",
  "src/components/hub-tabs.browser.test.tsx",
  "src/components/tooltip-title.browser.test.ts",
  "src/pages/chat/chat-composer-mobile.browser.test.tsx",
  "src/pages/chat/chat-composer-context.browser.test.ts",
  "src/pages/chat/chat-composer-context.palette.browser.test.ts",
  "src/pages/chat/chat-composer-overflow.browser.test.tsx",
  "src/pages/chat/chat-composer-queue.browser.test.tsx",
  "src/pages/chat/chat-queue-images.browser.test.ts",
  "src/pages/chat/components/chat-effort-picker.browser.test.tsx",
  "src/pages/chat/components/chat-details.browser.test.ts",
  "src/pages/chat/components/chat-message-reactions.browser.test.tsx",
  "src/pages/chat/components/chat-model-picker.browser.test.tsx",
  "src/pages/chat/components/chat-pane-header.browser.test.tsx",
  "src/pages/chat/components/chat-pane-versions-menu.browser.test.ts",
  "src/components/overlay-anchor.browser.test.ts",
  "src/components/overlay-lifecycle.browser.test.ts",
  "src/components/overlay-shadow.browser.test.ts",
  "src/components/solid/*.browser.test.tsx",
  "src/components/image-lightbox.browser.test.ts",
  "src/components/markdown-mermaid-expansion.browser.test.ts",
  "src/components/modal-dialog.browser.test.ts",
  "src/components/sessions-hub-header.browser.test.ts",
  "src/components/transient-container.browser.test.ts",
].map((file) => resolveUiTypeScriptPath(file, here));

export function createUiBrowserVitestConfig(
  env = process.env,
  browser: "chromium" | "webkit" = "chromium",
): ViteUserConfig {
  const include = includeUiTests(
    browser === "webkit"
      ? webkitTestFiles
      : ["src/**/*.browser.test.{ts,tsx}", "../extensions/*/browser/**/*.browser.test.{ts,tsx}"],
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
  if (browser === "chromium" && !excludesBrowserFiles && chromiumLaunchOptions === null) {
    chromiumLaunchOptions = resolveChromiumLaunchOptions();
  }
  const provider = playwright({
    launchOptions:
      browser === "chromium"
        ? {
            ...chromiumLaunchOptions,
            // Keep real canvas encoding without Chromium's idle-task watchdog in test pages.
            args: ["--enable-blink-features=NoIdleEncodingForWebTests"],
          }
        : undefined,
  });
  if (excludesBrowserFiles) {
    // Keep browser discovery for native sharding; only skip its speculative launch.
    delete provider.prewarm;
  }
  return defineProject({
    root: here,
    plugins: [
      controlUiSolidPlugin(),
      peleClassicBundlePlugin(),
      controlUiLocaleModulesPlugin(),
      createVitestProjectCachePlugin(),
      createRedactingReporterPlugin(),
    ],
    optimizeDeps: {
      include: [
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/language-data",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/highlight",
        "@noble/ed25519",
        "@noble/hashes/sha2.js",
        "@noble/hashes/utils.js",
        "@openclaw/normalization-core > libphonenumber-js/min",
        "@openclaw/normalization-core > libphonenumber-js/min/metadata",
        "@openclaw/uirouter",
        "@panzoom/panzoom",
        "@solidjs/signals",
        "@solidjs/testing-library",
        "@tanstack/virtual-core",
        "@zag-js/menu",
        "@zag-js/rect-utils",
        "@zag-js/vanilla",
        "croner",
        "dompurify",
        "file-type",
        "highlight.js/lib/core",
        "highlight.js/lib/languages/{bash,cpp,css,diff,go,java,javascript,json,markdown,python,rust,typescript,xml,yaml}",
        "ipaddr.js",
        "json5",
        "jsonc-parser",
        "markdown-it",
        "markdown-it-cjk-friendly",
        "markdown-it-emoji/lib/data/full.mjs",
        "remend",
        "string-width",
        "typebox",
        "typebox/schema",
        "typebox/compile",
        "typebox/guard",
        "typebox/value",
        "yaml",
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
      name: browser === "webkit" ? "webkit" : "browser",
      // No cleanup runner: it imports node:fs and repo server modules, which
      // cannot load in browser mode. Browser files own their own teardown.
      include,
      exclude: [...nodeDrivenBrowserLayoutTests],
      setupFiles: ["./src/test-helpers/dom.setup.ts"],
      browser: {
        enabled: true,
        provider,
        commands: { overlayEmulateMedia },
        instances: [{ browser, name: browser }],
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
        plugins: [
          controlUiSolidPlugin(),
          controlUiLocaleModulesPlugin(),
          createVitestProjectCachePlugin(),
        ],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          name: "unit",
          // isolate:false shares one worker module graph and jsdom window across
          // files, so the first file to evaluate a component owns it for the rest
          // of the worker and a later file's vi.mock never reaches production.
          // The cleanup runner retires that state per file; without it the lane
          // fails whichever sibling the size sequencer happens to pack together.
          runner: nonIsolatedRunnerPath,
          include: includeUiTests([
            "src/**/*.test.{ts,tsx}",
            "../extensions/*/browser/**/*.test.{ts,tsx}",
          ]),
          exclude: [
            "src/**/*.browser.test.{ts,tsx}",
            "src/**/*.e2e.test.{ts,tsx}",
            "src/**/*.node.test.{ts,tsx}",
            "../extensions/*/browser/**/*.browser.test.{ts,tsx}",
            "../extensions/*/browser/**/*.e2e.test.{ts,tsx}",
            "../extensions/*/browser/**/*.node.test.{ts,tsx}",
            ...mockRegistryUnitTests,
          ],
          environment: "jsdom",
          setupFiles: nodeSetupFiles,
        },
      },
      {
        extends: false,
        plugins: [
          controlUiSolidPlugin(),
          controlUiLocaleModulesPlugin(),
          createVitestProjectCachePlugin(),
        ],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          // Reuse the canonical singleton-sensitive list so the package and
          // root runners isolate the same tests without slowing the main suite.
          isolate: true,
          name: "unit-mock-registry",
          include: includeUiTests([...mockRegistryUnitTests]),
          environment: "jsdom",
          setupFiles: nodeSetupFiles,
        },
      },
      {
        extends: false,
        plugins: [
          controlUiSolidPlugin(),
          controlUiLocaleModulesPlugin(),
          createVitestProjectCachePlugin(),
        ],
        resolve: {
          alias: workspaceSourceAliases,
        },
        test: {
          ...sharedUiTestConfig,
          name: "unit-node",
          exclude: [...timingTests, ...mockRegistryUnitTests],
          // No cleanup runner: this project also carries the Playwright-driven
          // layout tests, whose browser lives in module scope. Resetting the
          // module graph between files churns that browser and flakes them.
          include: includeUiTests([
            "src/**/*.node.test.{ts,tsx}",
            "../extensions/*/browser/**/*.node.test.{ts,tsx}",
            ...nodeDrivenBrowserLayoutTests,
          ]),
          environment: "jsdom",
          setupFiles: nodeSetupFiles,
        },
      },
      { ...createUiBrowserVitestConfig(), extends: false },
      ...(process.env.OPENCLAW_UI_WEBKIT === "1"
        ? [{ ...createUiBrowserVitestConfig(process.env, "webkit"), extends: false }]
        : []),
      {
        extends: false,
        plugins: [
          controlUiSolidPlugin(),
          controlUiLocaleModulesPlugin(),
          createVitestProjectCachePlugin(),
        ],
        resolve: { alias: workspaceSourceAliases },
        test: {
          ...sharedUiTestConfig,
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
