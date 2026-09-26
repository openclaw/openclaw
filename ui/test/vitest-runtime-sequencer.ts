import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BaseSequencer, type TestSpecification } from "vitest/node";

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

export class UiTestSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // eslint-disable-next-line unicorn/no-array-sort -- BaseSequencer.sort is Vitest's ordering API.
    const sorted = await super.sort(files);
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
