import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const qaChannelExtensionTestRoot = bundledPluginRoot("qa-channel");

export const qaLabRuntimeTestFiles = [
  "extensions/qa-lab/src/cli.runtime.test.ts",
  "extensions/qa-lab/src/docker-harness.test.ts",
  "extensions/qa-lab/src/docker-up.runtime.test.ts",
  "extensions/qa-lab/src/gateway-child.test.ts",
  "extensions/qa-lab/src/lab-server.test.ts",
  "extensions/qa-lab/src/manual-lane.runtime.test.ts",
  "extensions/qa-lab/src/mock-openai-server.test.ts",
  "extensions/qa-lab/src/model-catalog.runtime.test.ts",
];

export const qaLabCoreTestFiles = [
  "extensions/qa-lab/src/bus-state.test.ts",
  "extensions/qa-lab/src/cron-run-wait.test.ts",
  "extensions/qa-lab/src/discovery-eval.test.ts",
  "extensions/qa-lab/src/gateway-rpc-client.test.ts",
  "extensions/qa-lab/src/live-timeout.test.ts",
  "extensions/qa-lab/src/model-switch-eval.test.ts",
  "extensions/qa-lab/src/qa-agent-workspace.test.ts",
  "extensions/qa-lab/src/qa-gateway-config.test.ts",
  "extensions/qa-lab/src/run-config.test.ts",
  "extensions/qa-lab/src/scenario-catalog.test.ts",
  "extensions/qa-lab/src/self-check.test.ts",
];
