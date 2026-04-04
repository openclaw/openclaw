import {
  bundledPluginDependentUnitTestFiles,
  unitTestAdditionalExcludePatterns,
} from "./vitest.unit-paths.mjs";
import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

const bundledUnitExcludePatterns = unitTestAdditionalExcludePatterns.filter(
  (pattern) => !bundledPluginDependentUnitTestFiles.includes(pattern),
);

export default createUnitVitestConfigWithOptions(process.env, {
  includePatterns: bundledPluginDependentUnitTestFiles,
  extraExcludePatterns: bundledUnitExcludePatterns,
});
