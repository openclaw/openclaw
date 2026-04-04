import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAutoReplyVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/auto-reply/**/*.test.ts"], {
    dir: "src/auto-reply",
    env,
  });
}

export default createAutoReplyVitestConfig();
