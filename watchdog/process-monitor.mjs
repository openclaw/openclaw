/**
 * Process Monitor
 *
 * Manages the OpenClaw gateway process lifecycle. Starts the process
 * from the active build, monitors its health via the gateway WebSocket,
 * and handles restarts and rollbacks on failure.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import {
  resolveRepoRoot,
  resolveBuildsDir,
  getActiveBuild,
  getShortHash,
  rollback,
  buildAndActivate,
} from "./build-manager.mjs";

const DEFAULT_GATEWAY_PORT = 18789;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const STARTUP_GRACE_PERIOD_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RESTART_COOLDOWN_MS = 10_000;
const MAX_RESTARTS_PER_HOUR = 5;

export class ProcessMonitor {
  constructor(repoRoot, options = {}) {
    this.repoRoot = repoRoot;
    this.port = options.port ?? DEFAULT_GATEWAY_PORT;
    this.stateDir = options.stateDir ?? path.join(repoRoot, ".watchdog");
    this.onProgress = options.onProgress ?? console.log;
    this.onError = options.onError ?? console.error;

    this.process = null;
    this.healthTimer = null;
    this.consecutiveFailures = 0;
    this.restartTimestamps = [];
    this.startedAt = null;
    this.stopped = false;
    this.currentCommitHash = null;

    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  /**
   * Get the entry point path for the active build.
   */
  getEntryPoint() {
    const buildsDir = resolveBuildsDir(this.repoRoot);
    const currentLink = path.join(buildsDir, "current");

    if (!fs.existsSync(currentLink)) {
      return null;
    }

    // Resolve the symlink to get the actual build directory
    const buildDir = fs.realpathSync(currentLink);
    const entryPoint = path.join(buildDir, "openclaw.mjs");

    if (!fs.existsSync(entryPoint)) {
      return null;
    }

    return entryPoint;
  }

  /**
   * Start the OpenClaw gateway process.
   */
  start() {
    if (this.process) {
      this.onError("Process already running");
      return false;
    }

    const entryPoint = this.getEntryPoint();
    if (!entryPoint) {
      this.onError("No active build found. Run 'watchdog build' first.");
      return false;
    }

    this.currentCommitHash = getActiveBuild(this.repoRoot);
    const shortHash = this.currentCommitHash ? getShortHash(this.currentCommitHash) : "unknown";

    this.onProgress(`Starting OpenClaw (build ${shortHash})...`);

    const buildDir = path.dirname(entryPoint);

    this.process = spawn("node", [entryPoint, "gateway"], {
      cwd: buildDir,
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_PORT: String(this.port),
        OPENCLAW_BUILD_HASH: this.currentCommitHash ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.startedAt = Date.now();

    // Pipe stdout/stderr to log file
    const logPath = path.join(this.stateDir, "gateway.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const timestamp = () => new Date().toISOString();

    this.process.stdout.on("data", (chunk) => {
      logStream.write(`[${timestamp()}] [stdout] ${chunk}`);
    });

    this.process.stderr.on("data", (chunk) => {
      logStream.write(`[${timestamp()}] [stderr] ${chunk}`);
    });

    this.process.on("exit", (code, signal) => {
      const runtime = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;

      this.onProgress(`OpenClaw exited (code=${code}, signal=${signal}, runtime=${runtime}s)`);
      logStream.write(`[${timestamp()}] Process exited: code=${code} signal=${signal}\n`);

      this.process = null;
      this.stopHealthCheck();

      if (!this.stopped) {
        this.handleCrash(code, signal);
      }
    });

    this.process.on("error", (err) => {
      this.onError(`Failed to start process: ${err.message}`);
      logStream.write(`[${timestamp()}] Spawn error: ${err.message}\n`);
      this.process = null;
    });

    // Start health checking after grace period
    setTimeout(() => {
      if (this.process && !this.stopped) {
        this.startHealthCheck();
      }
    }, STARTUP_GRACE_PERIOD_MS);

    // Write PID file
    this.writePidFile(this.process.pid);

    return true;
  }

  /**
   * Gracefully stop the OpenClaw process.
   */
  async stop(timeoutMs = 10_000) {
    this.stopped = true;
    this.stopHealthCheck();

    if (!this.process) {
      return;
    }

    this.onProgress("Stopping OpenClaw...");

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.onProgress("Graceful shutdown timed out, sending SIGKILL...");
        this.process?.kill("SIGKILL");
      }, timeoutMs);

      this.process.once("exit", () => {
        clearTimeout(timeout);
        this.process = null;
        this.removePidFile();
        resolve();
      });

      // Send SIGTERM for graceful shutdown
      this.process.kill("SIGTERM");
    });
  }

  /**
   * Restart the process (stop then start).
   */
  async restart(reason) {
    this.onProgress(`Restarting OpenClaw (reason: ${reason})...`);
    await this.stop();
    this.stopped = false;

    // Brief cooldown
    await new Promise((r) => setTimeout(r, RESTART_COOLDOWN_MS));

    return this.start();
  }

  /**
   * Handle a process crash. Decides whether to restart or rollback.
   */
  async handleCrash(exitCode, signal) {
    const now = Date.now();

    // Track restart frequency
    this.restartTimestamps.push(now);
    this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts < 3600_000);

    // If too many restarts in the last hour, try rollback
    if (this.restartTimestamps.length >= MAX_RESTARTS_PER_HOUR) {
      this.onProgress(
        `Too many restarts (${this.restartTimestamps.length} in the last hour). Attempting rollback...`,
      );

      try {
        const result = rollback(this.repoRoot);
        this.onProgress(
          `Rolled back from ${getShortHash(result.from)} to ${getShortHash(result.to)}`,
        );
        this.restartTimestamps = []; // Reset counter after rollback
        await this.restart("rollback");
      } catch (err) {
        this.onError(`Rollback failed: ${err.message}. Giving up.`);
        this.writeState({ status: "failed", reason: "rollback-failed", error: err.message });
      }
      return;
    }

    // Normal restart
    this.onProgress(
      `Process crashed (exit=${exitCode}, signal=${signal}). Restarting in ${RESTART_COOLDOWN_MS / 1000}s...`,
    );
    await new Promise((r) => setTimeout(r, RESTART_COOLDOWN_MS));

    if (!this.stopped) {
      this.start();
    }
  }

  /**
   * Check gateway health via WebSocket connection.
   */
  async checkHealth() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ ok: false, reason: "timeout" });
      }, HEALTH_CHECK_TIMEOUT_MS);

      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      ws.on("open", () => {
        // Gateway is accepting connections
        clearTimeout(timeout);
        ws.close();
        resolve({ ok: true });
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, reason: err.message });
      });
    });
  }

  /**
   * Start periodic health checks.
   */
  startHealthCheck() {
    if (this.healthTimer) return;

    this.healthTimer = setInterval(async () => {
      if (!this.process || this.stopped) {
        this.stopHealthCheck();
        return;
      }

      const result = await this.checkHealth();

      if (result.ok) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
        this.onProgress(
          `Health check failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${result.reason}`,
        );

        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.onProgress(`${MAX_CONSECUTIVE_FAILURES} consecutive health failures. Restarting...`);
          this.consecutiveFailures = 0;
          await this.restart("health-check-failure");
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Stop periodic health checks.
   */
  stopHealthCheck() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Check for updates, build, and hot-swap to the new version.
   * The running process is stopped, the new build is activated,
   * and the process is restarted.
   */
  async update({ branch = "main", remote = "origin", force = false } = {}) {
    this.onProgress("Checking for updates...");

    const result = await buildAndActivate(this.repoRoot, {
      pull: true,
      force,
      branch,
      remote,
      onProgress: this.onProgress,
    });

    if (result.action === "noop") {
      this.onProgress("No update needed");
      return result;
    }

    // New build is activated. Restart the process.
    if (this.process) {
      await this.restart(`update to ${getShortHash(result.commitHash)}`);
    }

    return result;
  }

  /**
   * Get current status.
   */
  getStatus() {
    const active = getActiveBuild(this.repoRoot);
    return {
      running: this.process !== null,
      pid: this.process?.pid ?? null,
      activeBuild: active ? getShortHash(active) : null,
      activeCommitHash: active,
      port: this.port,
      uptime: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      consecutiveHealthFailures: this.consecutiveFailures,
      restartsLastHour: this.restartTimestamps.length,
    };
  }

  writePidFile(pid) {
    fs.writeFileSync(path.join(this.stateDir, "gateway.pid"), String(pid));
  }

  removePidFile() {
    try {
      fs.unlinkSync(path.join(this.stateDir, "gateway.pid"));
    } catch {
      // OK
    }
  }

  writeState(state) {
    fs.writeFileSync(
      path.join(this.stateDir, "state.json"),
      JSON.stringify({ ...state, timestamp: new Date().toISOString() }, null, 2) + "\n",
    );
  }
}
