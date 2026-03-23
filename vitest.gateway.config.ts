import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(["src/gateway/**/*.test.ts"], {
  dir: "src/gateway",
});
