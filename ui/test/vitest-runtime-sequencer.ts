import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { loadPatternListFromEnv } from "../../test/vitest/vitest.pattern-file.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

export class UiRuntimePartitionSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const included = loadPatternListFromEnv("OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE");
    const selected = included && new Set(included);
    // Native shard() must see the complete inventory before runtime membership
    // narrows it; filtering discovery would move unrelated files between CI rows.
    const selectedFiles = selected
      ? files.filter((file) =>
          selected.has(path.relative(repoRoot, file.moduleId).replaceAll("\\", "/")),
        )
      : files;
    if (selected && files.length > 0 && selectedFiles.length === 0) {
      // This runtime has no members in a valid shard; missing discovery still fails.
      this.ctx.config.passWithNoTests = true;
      console.log("[ui-runtime] native shard has no files for this runtime partition");
    }
    // eslint-disable-next-line unicorn/no-array-sort -- BaseSequencer.sort is Vitest's ordering API.
    return super.sort(selectedFiles);
  }
}
