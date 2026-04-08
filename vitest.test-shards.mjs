export const autoReplyCoreTestInclude = ["src/auto-reply/*.test.ts"];

export const autoReplyCoreTestExclude = ["src/auto-reply/reply*.test.ts"];

export const autoReplyTopLevelReplyTestInclude = ["src/auto-reply/reply*.test.ts"];

export const autoReplyReplySubtreeTestInclude = ["src/auto-reply/reply/**/*.test.ts"];

export const fullSuiteVitestShards = [
  {
    config: "vitest.full-core-unit-fast.config.ts",
    name: "core-unit-fast",
    projects: ["vitest.unit-fast.config.ts"],
  },
  {
    config: "vitest.full-core-unit-src.config.ts",
    name: "core-unit-src",
    projects: ["vitest.unit-src.config.ts"],
  },
  {
    config: "vitest.full-core-unit-security.config.ts",
    name: "core-unit-security",
    projects: ["vitest.unit-security.config.ts"],
  },
  {
    config: "vitest.full-core-unit-ui.config.ts",
    name: "core-unit-ui",
    projects: ["vitest.unit-ui.config.ts"],
  },
  {
    config: "vitest.full-core-unit-support.config.ts",
    name: "core-unit-support",
    projects: ["vitest.unit-support.config.ts"],
  },
  {
    config: "vitest.full-core-support-boundary.config.ts",
    name: "core-support-boundary",
    projects: ["vitest.boundary.config.ts", "vitest.tooling.config.ts"],
  },
  {
    config: "vitest.full-core-contracts.config.ts",
    name: "core-contracts",
    projects: ["vitest.contracts.config.ts"],
  },
  {
    config: "vitest.full-core-bundled.config.ts",
    name: "core-bundled",
    projects: ["vitest.bundled.config.ts"],
  },
  {
    config: "vitest.full-core-runtime.config.ts",
    name: "core-runtime",
    projects: [
      "vitest.infra.config.ts",
      "vitest.hooks.config.ts",
      "vitest.acp.config.ts",
      "vitest.runtime-config.config.ts",
      "vitest.secrets.config.ts",
      "vitest.logging.config.ts",
      "vitest.process.config.ts",
      "vitest.cron.config.ts",
      "vitest.media.config.ts",
      "vitest.media-understanding.config.ts",
      "vitest.shared-core.config.ts",
      "vitest.tasks.config.ts",
      "vitest.tui.config.ts",
      "vitest.ui.config.ts",
      "vitest.utils.config.ts",
      "vitest.wizard.config.ts",
    ],
  },
  {
    config: "vitest.full-agentic.config.ts",
    name: "agentic",
    projects: [
      "vitest.gateway.config.ts",
      "vitest.cli.config.ts",
      "vitest.commands-light.config.ts",
      "vitest.commands.config.ts",
      "vitest.agents.config.ts",
      "vitest.daemon.config.ts",
      "vitest.plugin-sdk-light.config.ts",
      "vitest.plugin-sdk.config.ts",
      "vitest.plugins.config.ts",
      "vitest.channels.config.ts",
    ],
  },
  {
    config: "vitest.full-auto-reply.config.ts",
    name: "auto-reply",
    projects: [
      "vitest.auto-reply-core.config.ts",
      "vitest.auto-reply-top-level.config.ts",
      "vitest.auto-reply-reply.config.ts",
    ],
  },
  {
    config: "vitest.full-extensions.config.ts",
    name: "extensions",
    projects: [
      "vitest.extension-acpx.config.ts",
      "vitest.extension-bluebubbles.config.ts",
      "vitest.extension-channels.config.ts",
      "vitest.extension-diffs.config.ts",
      "vitest.extension-feishu.config.ts",
      "vitest.extension-irc.config.ts",
      "vitest.extension-mattermost.config.ts",
      "vitest.extension-matrix.config.ts",
      "vitest.extension-memory.config.ts",
      "vitest.extension-messaging.config.ts",
      "vitest.extension-msteams.config.ts",
      "vitest.extension-providers.config.ts",
      "vitest.extension-telegram.config.ts",
      "vitest.extension-voice-call.config.ts",
      "vitest.extension-whatsapp.config.ts",
      "vitest.extension-zalo.config.ts",
      "vitest.extensions.config.ts",
    ],
  },
];
