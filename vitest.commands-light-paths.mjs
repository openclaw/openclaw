const normalizeRepoPath = (value) => value.replaceAll("\\", "/");

const commandsLightEntries = [
  { source: "src/commands/cleanup-utils.ts", test: "src/commands/cleanup-utils.test.ts" },
  {
    source: "src/commands/dashboard.links.ts",
    test: "src/commands/dashboard.links.test.ts",
  },
  { source: "src/commands/doctor-browser.ts", test: "src/commands/doctor-browser.test.ts" },
  {
    source: "src/commands/doctor-gateway-auth-token.ts",
    test: "src/commands/doctor-gateway-auth-token.test.ts",
  },
  {
    source: "src/commands/sandbox-formatters.ts",
    test: "src/commands/sandbox-formatters.test.ts",
  },
  {
    source: "src/commands/status-overview-rows.ts",
    test: "src/commands/status-overview-rows.test.ts",
  },
  {
    source: "src/commands/status-overview-surface.ts",
    test: "src/commands/status-overview-surface.test.ts",
  },
  {
    source: "src/commands/status-overview-values.ts",
    test: "src/commands/status-overview-values.test.ts",
  },
  { source: "src/commands/text-format.ts", test: "src/commands/text-format.test.ts" },
];

const commandsLightIncludePatternByFile = new Map(
  commandsLightEntries.flatMap(({ source, test }) => [
    [source, test],
    [test, test],
  ]),
);

export const commandsLightSourceFiles = commandsLightEntries.map(({ source }) => source);
export const commandsLightTestFiles = commandsLightEntries.map(({ test }) => test);

export function isCommandsLightTarget(file) {
  return commandsLightIncludePatternByFile.has(normalizeRepoPath(file));
}

export function isCommandsLightTestFile(file) {
  return commandsLightTestFiles.includes(normalizeRepoPath(file));
}

export function resolveCommandsLightIncludePattern(file) {
  return commandsLightIncludePatternByFile.get(normalizeRepoPath(file)) ?? null;
}
