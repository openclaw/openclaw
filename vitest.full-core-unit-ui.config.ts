import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";
import { fullSuiteVitestShards } from "./vitest.test-shards.mjs";

export default createProjectShardVitestConfig(
  fullSuiteVitestShards.find((shard) => shard.config === "vitest.full-core-unit-ui.config.ts")
    ?.projects ?? [],
);
