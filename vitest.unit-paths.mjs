import path from "node:path";

export const unitTestIncludePatterns = [
  "src/**/*.test.ts",
  "packages/**/*.test.ts",
  "test/**/*.test.ts",
  "ui/src/ui/app-chat.test.ts",
  "ui/src/ui/chat/**/*.test.ts",
  "ui/src/ui/views/agents-utils.test.ts",
  "ui/src/ui/views/channels.test.ts",
  "ui/src/ui/views/chat.test.ts",
  "ui/src/ui/views/usage-render-details.test.ts",
  "ui/src/ui/controllers/agents.test.ts",
  "ui/src/ui/controllers/chat.test.ts",
];

export const unitTestAdditionalExcludePatterns = [
  "src/gateway/**",
  "extensions/**",
  "src/browser/**",
  "src/line/**",
  "src/agents/**",
  "src/auto-reply/**",
  "src/commands/**",
  "src/channels/plugins/contracts/**",
  "src/plugins/contracts/**",
];

const sharedBaseExcludePatterns = [
  "dist/**",
  "apps/macos/**",
  "apps/macos/.build/**",
  "**/node_modules/**",
  "**/vendor/**",
  "dist/OpenClaw.app/**",
  "**/*.live.test.ts",
  "**/*.e2e.test.ts",
];

const normalizeRepoPath = (value) => value.split(path.sep).join("/");

const matchesAny = (file, patterns) => patterns.some((pattern) => path.matchesGlob(file, pattern));

export function isUnitConfigTestFile(file) {
  const normalizedFile = normalizeRepoPath(file);
  return (
    matchesAny(normalizedFile, unitTestIncludePatterns) &&
    !matchesAny(normalizedFile, sharedBaseExcludePatterns) &&
    !matchesAny(normalizedFile, unitTestAdditionalExcludePatterns)
  );
}
