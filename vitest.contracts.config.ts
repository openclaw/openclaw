import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createContractsVitestConfig(env?: Record<string, string | undefined>) {
  const contractsEnv = {
    OPENCLAW_SKIP_DEFAULT_TEST_PLUGIN_REGISTRY: "1",
    ...env,
  };
  return createScopedVitestConfig(
    ["src/channels/plugins/contracts/**/*.test.ts", "src/plugins/contracts/**/*.test.ts"],
    {
      env: contractsEnv,
      passWithNoTests: true,
    },
  );
}

export default createContractsVitestConfig();
