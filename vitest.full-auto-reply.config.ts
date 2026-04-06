import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";
import { fullSuiteVitestShards } from "./vitest.test-shards.mjs";

export default createProjectShardVitestConfig(
  fullSuiteVitestShards.find((shard) => shard.config === "vitest.full-auto-reply.config.ts")
    ?.projects ?? [],
);
