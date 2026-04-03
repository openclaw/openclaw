import { defineConfig } from "vitest/config";
import { createBoundaryVitestConfig } from "./vitest.boundary.config.ts";
import baseConfig from "./vitest.config.ts";
import { createUnitVitestConfig } from "./vitest.unit.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest =
  (
    baseConfig as {
      test?: {
        include?: string[];
        exclude?: string[];
        setupFiles?: string[];
      };
    }
  ).test ?? {};
const unitTest = createUnitVitestConfig({}).test ?? {};
const boundaryTest = createBoundaryVitestConfig({}).test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: unitTest.include,
          exclude: unitTest.exclude,
          isolate: unitTest.isolate,
          runner: unitTest.runner,
          setupFiles: unitTest.setupFiles,
        },
      },
      {
        extends: true,
        test: {
          name: "boundary",
          include: boundaryTest.include,
          exclude: boundaryTest.exclude,
          isolate: boundaryTest.isolate,
          runner: boundaryTest.runner,
          setupFiles: boundaryTest.setupFiles,
        },
      },
    ],
  },
});
