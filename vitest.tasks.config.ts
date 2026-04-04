import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createTasksVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/tasks/**/*.test.ts"], {
    dir: "src",
    env,
    name: "tasks",
    passWithNoTests: true,
  });
}

export default createTasksVitestConfig();
