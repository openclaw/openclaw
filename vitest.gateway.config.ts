import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayVitestConfig() {
  return createScopedVitestConfig(["src/gateway/**/*.test.ts"], {
    dir: "src/gateway",
  });
}

export default createGatewayVitestConfig();
