import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function createContractsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    [
      "src/channels/plugins/contracts/**/*.test.ts",
      "src/config/doc-baseline.integration.test.ts",
      "src/config/schema.base.generated.test.ts",
      "src/config/schema.help.quality.test.ts",
      "src/plugins/contracts/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    {
      env,
      exclude: boundaryTestFiles,
      name: "contracts",
      passWithNoTests: true,
    },
  );
}

export default createContractsVitestConfig();
