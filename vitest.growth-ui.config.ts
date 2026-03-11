// Where: vitest.growth-ui.config.ts
// What: scopes Vitest to the growth foundation UI/browser test lane.
// Why: keeps PR Watch and growth panel regressions easy to verify without ad hoc config.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig([
  "ui/src/ui/controllers/growth-foundation.test.ts",
  "ui/src/ui/views/overview.browser.test.ts",
]);
