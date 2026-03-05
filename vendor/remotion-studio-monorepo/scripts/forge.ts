#!/usr/bin/env tsx
import { spawnSync } from "child_process";

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof COLORS = "reset") {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function getPnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function runPnpm(args: string[], cwd = process.cwd()): number {
  const command = getPnpmCommand();
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    log(`Failed to start pnpm: ${result.error.message}`, "red");
    return 1;
  }

  return result.status ?? 1;
}

function printHelp(): void {
  log("\n🔥 Remotion Forge", "blue");
  log("\nUsage: pnpm forge <command>", "cyan");
  log("\nCommands:", "cyan");
  log("  studio            Start Next.js Studio dashboard", "yellow");
  log("  launch            Open CLI launcher fallback (dev/render)", "yellow");
  log("  render [args...]  Proxy to `pnpm render`", "yellow");
  log("  ai:generate       Phase 1 placeholder", "yellow");
  log("  outputs           Phase 1 placeholder", "yellow");
  log("\nExamples:", "cyan");
  log("  pnpm forge studio", "yellow");
  log("  pnpm forge launch", "yellow");
  log("  pnpm forge render --app my-app --composition Main", "yellow");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printHelp();
    return;
  }

  if (command === "studio") {
    const studioStatus = runPnpm(
      ["--filter", "@studio/studio", "run", "dev", ...rest],
      process.cwd(),
    );

    if (studioStatus === 0) {
      return;
    }

    log("\nStudio dashboard failed. Falling back to CLI launcher...", "yellow");
    const fallbackStatus = runPnpm(
      ["tsx", "scripts/forge-launcher.ts"],
      process.cwd(),
    );
    process.exit(fallbackStatus);
  }

  if (command === "launch" || command === "launcher") {
    const status = runPnpm(["tsx", "scripts/forge-launcher.ts", ...rest]);
    process.exit(status);
  }

  if (command === "render") {
    const status = runPnpm(["render", ...rest]);
    process.exit(status);
  }

  if (command === "ai:generate" || command === "outputs") {
    log(
      `${command} is planned for Phase 1 and is not implemented yet.`,
      "yellow",
    );
    process.exit(0);
  }

  log(`Unknown forge command: ${command}`, "red");
  printHelp();
  process.exit(1);
}

main();
