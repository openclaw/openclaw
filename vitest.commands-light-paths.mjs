const normalizeRepoPath = (value) => value.replaceAll("\\", "/");

export const commandsLightTestFiles = [
  "src/commands/cleanup-utils.test.ts",
  "src/commands/dashboard.links.test.ts",
  "src/commands/doctor-browser.test.ts",
  "src/commands/doctor-gateway-auth-token.test.ts",
];

export function isCommandsLightTestFile(file) {
  return commandsLightTestFiles.includes(normalizeRepoPath(file));
}
