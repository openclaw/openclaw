import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BaseSequencer,
  type TestSequencer,
  type TestSpecification,
  type Vitest,
} from "vitest/node";
import { loadPatternListFromEnv } from "../../test/vitest/vitest.pattern-file.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

async function readSchedulingEnvironment(file: TestSpecification) {
  // Vitest exposes no pre-run environment metadata. Match its first pragma
  // (including Jest aliases); the native pool still owns setup and reuse.
  const source = await readFile(file.moduleId, "utf8").catch(() => "");
  const name =
    source.match(/@(?:vitest|jest)-environment\s+([\w-]+)\b/u)?.[1] ??
    (file.project.config.environment || "node");
  let optionsJson = source.match(/@(?:vitest|jest)-environment-options\s+(.+)/u)?.[1];
  if (optionsJson?.endsWith("*/")) {
    optionsJson = optionsJson.slice(0, -2);
  }
  const options: unknown = JSON.parse(optionsJson || "null");
  return { name, options: options || null, pool: file.pool };
}

export class UiRuntimePartitionSequencer extends BaseSequencer {
  private readonly nativeOrder?: TestSequencer;

  constructor(ctx: Vitest, nativeOrder?: TestSequencer) {
    super(ctx);
    this.nativeOrder = nativeOrder;
    // Vitest recognizes files-only shuffling by exact sequencer identity.
    if (nativeOrder && ctx.getSeed() === null) {
      ctx.logger.log(`[ui-runtime] file shuffle seed: ${ctx.config.sequence.seed}`);
    }
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const receiptFile = process.env.OPENCLAW_VITEST_NATIVE_SHARD_RECEIPT;
    const requestId = process.env.OPENCLAW_VITEST_NATIVE_SHARD_REQUEST_ID;
    if (receiptFile && requestId) {
      // The coordinator can omit an empty sibling runtime only from Vitest's
      // original shard inventory, before this sequencer narrows membership.
      await writeFile(
        receiptFile,
        JSON.stringify({
          version: 1,
          requestId,
          config: this.ctx.vite.config.configFile,
          root: this.ctx.config.root,
          files: files.map((file) => path.relative(repoRoot, file.moduleId).replaceAll("\\", "/")),
        }),
        { encoding: "utf8", flag: "wx" },
      ).catch(() => {
        // Missing or invalid receipts retain the ordinary Node invocation.
      });
    }
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
    if (this.nativeOrder) {
      // Explicit file shuffling owns ordering after runtime membership narrows.
      // eslint-disable-next-line unicorn/no-array-sort -- TestSequencer.sort is Vitest's ordering API.
      return this.nativeOrder.sort(selectedFiles);
    }
    // eslint-disable-next-line unicorn/no-array-sort -- BaseSequencer.sort is Vitest's ordering API.
    const sorted = await super.sort(selectedFiles);
    const projects = new Map<TestSpecification["project"], TestSpecification[]>();
    for (const file of sorted) {
      const projectFiles = projects.get(file.project) ?? [];
      projectFiles.push(file);
      projects.set(file.project, projectFiles);
    }
    const grouped = await Promise.all(
      [...projects.values()].map(async (projectFiles) => {
        if (
          projectFiles.some(
            (file) =>
              file.project.config.isolate ||
              (file.pool !== "threads" && file.pool !== "forks") ||
              this.ctx.cache.getFileTestResults(
                `${file.project.name}:${path.relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/")}`,
              ),
          )
        ) {
          return projectFiles;
        }
        const environments = await Promise.all(projectFiles.map(readSchedulingEnvironment));
        const groups: Array<{
          environment: (typeof environments)[number];
          files: TestSpecification[];
        }> = [];
        // A non-isolated worker retires when the queue head needs another
        // environment. Keep equal environments together without changing the
        // native order within them or overriding cached failure/duration order.
        for (const [index, file] of projectFiles.entries()) {
          const environment = environments[index]!;
          const group = groups.find((candidate) =>
            isDeepStrictEqual(candidate.environment, environment),
          );
          if (group) {
            group.files.push(file);
          } else {
            groups.push({ environment, files: [file] });
          }
        }
        // Spread smaller environments across the same rounds so they can
        // interrupt long worker runs. A lone environment cannot force a restart.
        const targetBatchSize = 96;
        const rounds = Math.ceil(
          Math.max(...groups.map((group) => group.files.length)) / targetBatchSize,
        );
        const interleaved: TestSpecification[] = [];
        for (let round = 0; round < rounds; round++) {
          for (const { files: groupFiles } of groups) {
            const start = Math.ceil((round * groupFiles.length) / rounds);
            const end = Math.ceil(((round + 1) * groupFiles.length) / rounds);
            interleaved.push(...groupFiles.slice(start, end));
          }
        }
        return interleaved;
      }),
    );
    return grouped.flat();
  }
}
