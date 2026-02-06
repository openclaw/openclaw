#!/usr/bin/env node

/**
 * Watchdog CLI
 *
 * Smart process manager for OpenClaw that handles versioned builds,
 * health monitoring, automatic restarts, and rollbacks.
 *
 * Usage:
 *   node watchdog/cli.mjs build          Build current commit
 *   node watchdog/cli.mjs start          Start the gateway from active build
 *   node watchdog/cli.mjs stop           Stop the running gateway
 *   node watchdog/cli.mjs restart        Restart the gateway
 *   node watchdog/cli.mjs update         Pull, build, and hot-swap
 *   node watchdog/cli.mjs rollback       Rollback to previous build
 *   node watchdog/cli.mjs status         Show current status
 *   node watchdog/cli.mjs builds         List all builds
 *   node watchdog/cli.mjs run            Build, start, and watch (main loop)
 *   node watchdog/cli.mjs prune          Remove old builds
 */

import {
  resolveRepoRoot,
  getCurrentCommitHash,
  getShortHash,
  buildAndActivate,
  listBuilds,
  getActiveBuild,
  rollback as doRollback,
  pruneBuilds,
  buildExists,
  buildCommit,
  activateBuild,
} from "./build-manager.mjs";
import { ProcessMonitor } from "./process-monitor.mjs";

const repoRoot = resolveRepoRoot();
const args = process.argv.slice(2);
const command = args[0];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

async function cmdBuild() {
  const force = args.includes("--force");
  const result = await buildAndActivate(repoRoot, {
    pull: false,
    force,
    onProgress: log,
  });

  if (result.action === "noop") {
    log("Nothing to do");
  } else if (result.action === "activated") {
    log(`Activated existing build ${getShortHash(result.commitHash)}`);
  } else {
    log(
      `Built and activated ${getShortHash(result.commitHash)} in ${(result.buildInfo.durationMs / 1000).toFixed(1)}s`,
    );
  }
}

async function cmdStart() {
  const port = getPortArg();
  const monitor = new ProcessMonitor(repoRoot, {
    port,
    onProgress: log,
    onError: logError,
  });

  // Handle shutdown signals
  const shutdown = async () => {
    log("Shutdown signal received");
    await monitor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const started = monitor.start();
  if (!started) {
    process.exit(1);
  }

  // Keep the process alive
  setInterval(() => {}, 60_000);
}

async function cmdStop() {
  const monitor = new ProcessMonitor(repoRoot, {
    onProgress: log,
    onError: logError,
  });
  await monitor.stop();
  log("Stopped");
}

async function cmdRestart() {
  const port = getPortArg();
  const monitor = new ProcessMonitor(repoRoot, {
    port,
    onProgress: log,
    onError: logError,
  });
  await monitor.restart("manual");
}

async function cmdUpdate() {
  const port = getPortArg();
  const force = args.includes("--force");
  const branch = getArgValue("--branch") ?? "main";
  const remote = getArgValue("--remote") ?? "origin";

  const monitor = new ProcessMonitor(repoRoot, {
    port,
    onProgress: log,
    onError: logError,
  });

  const result = await monitor.update({ branch, remote, force });
  log(`Update complete: ${result.action}`);
}

async function cmdRollback() {
  const targetHash = args[1] && !args[1].startsWith("--") ? args[1] : undefined;

  try {
    const result = doRollback(repoRoot, targetHash);
    log(`Rolled back: ${getShortHash(result.from)} -> ${getShortHash(result.to)}`);
    log("Run 'watchdog restart' to apply the rollback");
  } catch (err) {
    logError(err.message);
    process.exit(1);
  }
}

function cmdStatus() {
  const active = getActiveBuild(repoRoot);
  const commitHash = getCurrentCommitHash(repoRoot);
  const builds = listBuilds(repoRoot);

  console.log("");
  console.log("Watchdog Status");
  console.log("===============");
  console.log(`  Repository:    ${repoRoot}`);
  console.log(`  HEAD commit:   ${getShortHash(commitHash)} (${commitHash})`);
  console.log(`  Active build:  ${active ? `${getShortHash(active)} (${active})` : "none"}`);
  console.log(`  Total builds:  ${builds.length}`);
  console.log(`  HEAD built:    ${buildExists(repoRoot, commitHash) ? "yes" : "no"}`);
  console.log("");

  if (active && active !== commitHash) {
    console.log(
      `  NOTE: Active build (${getShortHash(active)}) differs from HEAD (${getShortHash(commitHash)})`,
    );
    console.log(`  Run 'watchdog build' or 'watchdog update' to sync`);
    console.log("");
  }
}

function cmdBuilds() {
  const builds = listBuilds(repoRoot);
  const active = getActiveBuild(repoRoot);

  if (builds.length === 0) {
    console.log("No builds found. Run 'watchdog build' to create one.");
    return;
  }

  console.log("");
  console.log(`Builds (${builds.length} total, newest first):`);
  console.log("");

  for (const build of builds) {
    const isActive = build.commitHash === active;
    const marker = isActive ? " * ACTIVE" : "";
    const duration = build.durationMs ? ` (${(build.durationMs / 1000).toFixed(1)}s)` : "";
    const builtAt = new Date(build.builtAt).toLocaleString();

    console.log(
      `  ${getShortHash(build.commitHash)}  ${build.branch ?? "??"}  "${build.commitMessage ?? "?"}"  built ${builtAt}${duration}${marker}`,
    );
  }
  console.log("");
}

async function cmdRun() {
  const port = getPortArg();
  const branch = getArgValue("--branch") ?? "main";
  const remote = getArgValue("--remote") ?? "origin";
  const pollInterval = parseInt(getArgValue("--poll") ?? "60", 10) * 1000;

  log("Watchdog starting in run mode");
  log(`Polling for updates every ${pollInterval / 1000}s on ${remote}/${branch}`);

  // Step 1: Build current commit if not already built
  const commitHash = getCurrentCommitHash(repoRoot);
  if (!buildExists(repoRoot, commitHash)) {
    log(`No build for HEAD (${getShortHash(commitHash)}). Building...`);
    await buildAndActivate(repoRoot, {
      pull: false,
      onProgress: log,
    });
  } else if (!getActiveBuild(repoRoot)) {
    activateBuild(repoRoot, commitHash);
    log(`Activated existing build ${getShortHash(commitHash)}`);
  }

  // Step 2: Start the process monitor
  const monitor = new ProcessMonitor(repoRoot, {
    port,
    onProgress: log,
    onError: logError,
  });

  const shutdown = async () => {
    log("Shutdown signal received");
    await monitor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  monitor.start();

  // Step 3: Poll for updates
  setInterval(async () => {
    if (monitor.stopped) return;

    try {
      const result = await monitor.update({ branch, remote });
      if (result.action !== "noop") {
        log(`Update applied: ${result.action} (${getShortHash(result.commitHash)})`);
      }
    } catch (err) {
      logError(`Update check failed: ${err.message}`);
    }
  }, pollInterval);
}

function cmdPrune() {
  const maxBuilds = parseInt(getArgValue("--keep") ?? "32", 10);
  const pruned = pruneBuilds(repoRoot, maxBuilds);

  if (pruned.length === 0) {
    log(`No builds to prune (${listBuilds(repoRoot).length} total, max ${maxBuilds})`);
  } else {
    log(`Pruned ${pruned.length} build(s): ${pruned.map(getShortHash).join(", ")}`);
  }
}

function getPortArg() {
  return parseInt(getArgValue("--port") ?? "18789", 10);
}

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function showHelp() {
  console.log(`
Watchdog: Smart OpenClaw Process Manager

Commands:
  build               Build current commit and activate it
  build --force       Force rebuild even if build exists
  start               Start the gateway from the active build
  stop                Stop the running gateway
  restart             Restart the gateway
  update              Pull latest, build if needed, hot-swap
  rollback [hash]     Rollback to a previous build
  status              Show current status
  builds              List all builds
  run                 Full lifecycle: build, start, and poll for updates
  prune               Remove old builds (keeps 32 by default)

Options:
  --port <port>       Gateway port (default: 18789)
  --branch <branch>   Git branch to track (default: main)
  --remote <remote>   Git remote (default: origin)
  --poll <seconds>    Update poll interval in run mode (default: 60)
  --keep <count>      Max builds to keep when pruning (default: 32)
  --force             Force rebuild
`);
}

// Main dispatcher
const commands = {
  build: cmdBuild,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  update: cmdUpdate,
  rollback: cmdRollback,
  status: cmdStatus,
  builds: cmdBuilds,
  run: cmdRun,
  prune: cmdPrune,
  help: showHelp,
  "--help": showHelp,
  "-h": showHelp,
};

const handler = commands[command];
if (!handler) {
  if (command) {
    console.error(`Unknown command: ${command}`);
  }
  showHelp();
  process.exit(command ? 1 : 0);
}

try {
  await handler();
} catch (err) {
  logError(err.message);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
}
