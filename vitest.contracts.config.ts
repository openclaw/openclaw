import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createContractsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    [
      "src/channels/plugins/contracts/**/*.test.ts",
      "src/channels/plugins/plugins-core.test.ts",
      "src/security/dm-policy-channel-smoke.test.ts",
      "src/plugins/contracts/**/*.test.ts",
      "src/tts/tts.test.ts",
    ],
    {
      env,
      passWithNoTests: true,
    },
  );
}

export default createContractsVitestConfig();
