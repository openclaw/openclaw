import path from "node:path";
import {
  bundledPluginDependentUnitTestFiles,
  unitTestAdditionalExcludePatterns,
} from "./vitest.unit-paths.mjs";
import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

const bundledUnitExcludePatterns = unitTestAdditionalExcludePatterns.filter(
  (pattern) => !bundledPluginDependentUnitTestFiles.some((file) => path.matchesGlob(file, pattern)),
);

export default createUnitVitestConfigWithOptions(process.env, {
  includePatterns: bundledPluginDependentUnitTestFiles,
  extraExcludePatterns: bundledUnitExcludePatterns,
  name: "bundled",
});
