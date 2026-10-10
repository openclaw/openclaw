import { afterAll, beforeAll, beforeEach, type RunnerTask } from "vitest";
import { webkitExpectedFailures as expectedFailures } from "./webkit-expected-failures.ts";

type TestTask = Extract<RunnerTask, { type: "test" }>;
const admitted = new Map<string, { task: TestTask; expected: (typeof expectedFailures)[number] }>();

function fullName(task: RunnerTask): string {
  return task.suite && task.suite !== task.file
    ? `${fullName(task.suite)} > ${task.name}`
    : task.name;
}

// oxlint-disable-next-line no-empty-pattern -- Vitest requires a destructured fixture before its suite argument.
beforeAll(({}, suite) => {
  const file = suite.file.filepath.replaceAll("\\", "/");
  const entries = expectedFailures.filter((entry) => file.endsWith(`/${entry.file}`));
  const visit = (task: RunnerTask) => {
    if (task.type !== "test") {
      task.tasks.forEach(visit);
      return;
    }
    const expected = entries.find((entry) => entry.name === fullName(task));
    if (!expected) {
      return;
    }
    if ([...admitted.values()].some((entry) => entry.expected === expected)) {
      throw new Error(`Duplicate WebKit expected failure: ${expected.name}`);
    }
    task.fails = true;
    admitted.set(task.id, { task, expected });
  };
  suite.tasks.forEach(visit);
  for (const entry of entries) {
    if (![...admitted.values()].some((item) => item.expected === entry)) {
      throw new Error(`Missing WebKit expected failure: ${entry.name}`);
    }
  }
});

beforeEach(({ task, onTestFinished }) => {
  const entry = admitted.get(task.id);
  if (!entry) {
    return;
  }
  onTestFinished(() => {
    const errors = entry.task.result?.errors;
    if (
      errors?.length &&
      !errors.every(
        (error) =>
          error.name === "AssertionError" &&
          error.message.includes(entry.expected.error) &&
          error.stack?.includes(entry.expected.file) &&
          (entry.expected.actual === undefined ||
            (typeof error.actual === "string" && error.actual.includes(entry.expected.actual))) &&
          (entry.expected.expected === undefined ||
            (typeof error.expected === "string" &&
              error.expected.includes(entry.expected.expected))) &&
          (!entry.expected.equalValues || error.actual === error.expected),
      )
    ) {
      // Do not let the expected assertion hide setup, cleanup, or unrelated failures.
      entry.task.fails = false;
    }
  });
});

afterAll(() => {
  for (const { task, expected } of admitted.values()) {
    if (task.result?.state === "skip" || task.result?.state === "todo") {
      throw new Error(`WebKit expected failure was skipped: ${expected.name}`);
    }
    if (task.result?.state === "pass") {
      console.info(
        `[WebKit expected failure] ${expected.name}: ${expected.observed} ${expected.cause}`,
      );
    }
  }
});
