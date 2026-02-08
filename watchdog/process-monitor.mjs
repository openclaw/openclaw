/**
 * Process Monitor
 *
 * Manages the OpenClaw gateway process lifecycle. Starts the process
 * from the active build, monitors its health via the gateway WebSocket,
 * and handles restarts and rollbacks on failure.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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

/**
 * Resolve the directory where the gateway stores its ephemeral lock files.
 * Mirrors the logic in src/config/paths.ts resolveGatewayLockDir().
 */
function resolveGatewayLockDir() {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
  return path.join(os.tmpdir(), suffix);
}

/**
 * Remove all gateway lock files so a freshly spawned gateway can acquire its lock.
 * Call this after killing stale gateway processes.
 */
function cleanupGatewayLockFiles(log) {
  const lockDir = resolveGatewayLockDir();
  try {
    const files = fs.readdirSync(lockDir);
    for (const file of files) {
      if (file.startsWith("gateway.") && file.endsWith(".lock")) {
        const lockPath = path.join(lockDir, file);
        try {
          const raw = fs.readFileSync(lockPath, "utf8");
          const payload = JSON.parse(raw);
          // Only remove if the owner PID is dead
          try {
            process.kill(payload.pid, 0);
            // PID is alive; leave it
          } catch {
            // PID is dead; safe to remove
            fs.unlinkSync(lockPath);
            log?.(`Cleaned up stale gateway lock for dead PID ${payload.pid}`);
          }
        } catch {
          // Malformed or unreadable lock; remove it
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // Lock dir doesn't exist yet; nothing to clean
  }
}

/**
 * Resolve the path for the watchdog's own port lock file.
 * Stored in ~/.openclaw/watchdog/ so it persists across repo checkouts.
 */
function resolveWatchdogLockPath(port) {
  const home = os.homedir();
  const lockDir = path.join(home, ".openclaw", "watchdog");
  fs.mkdirSync(lockDir, { recursive: true });
  return path.join(lockDir, `port-${port}.lock`);
}

/**
 * Attempt to acquire the watchdog port lock. Returns a release function on success.
 * Throws if another watchdog is already managing the same port.
 */
function acquireWatchdogLock(port, repoRoot, log) {
  const lockPath = resolveWatchdogLockPath(port);

  // Check existing lock
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const payload = JSON.parse(raw);
    // Check if the owner is still alive
    try {
      process.kill(payload.pid, 0);
      // Owner is alive; refuse to start
      throw new Error(
        `Another watchdog is already managing port ${port} (PID ${payload.pid}, repo ${payload.repoRoot}). ` +
          `Kill it first or use a different port with --port.`,
      );
    } catch (err) {
      if (err.code !== "ESRCH") {
        throw err;
      }
      // Owner is dead; clean up stale lock
      log?.(`Cleaned up stale watchdog lock for dead PID ${payload.pid}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) {
      throw err;
    }
  }

  // Write our lock
  const payload = {
    pid: process.pid,
    port,
    repoRoot,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2) + "\n");
  log?.(`Acquired watchdog lock for port ${port} (PID ${process.pid})`);

  const release = () => {
    try {
      // Only remove if we still own it
      const raw = fs.readFileSync(lockPath, "utf8");
      const current = JSON.parse(raw);
      if (current.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // ignore
    }
  };

  // Auto-release on exit. Only use the synchronous "exit" event here;
  // SIGINT/SIGTERM handlers in the caller (cli.mjs) handle graceful
  // shutdown via monitor.stop() before calling process.exit().
  process.on("exit", release);

  return release;
}

export { acquireWatchdogLock, cleanupGatewayLockFiles };

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

    // Synchronous exit handler ensures PID file is always cleaned up,
    // even if the async stop() flow is interrupted.
    process.on("exit", () => this.removePidFile());
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
   * Check if a process is listening on the gateway port and kill it.
   * Returns true if a stale process was found and killed.
   */
  async killStalePortProcess() {
    const inUse = await new Promise((resolve) => {
      const sock = net.createConnection({ port: this.port, host: "127.0.0.1" });
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        resolve(false);
      });
    });

    if (!inUse) {
      return false;
    }

    this.onProgress(`Port ${this.port} is in use. Killing stale process...`);

    try {
      // Find the PID using the port (macOS/Linux compatible)
      const output = execSync(`lsof -ti tcp:${this.port}`, { encoding: "utf-8" }).trim();
      if (output) {
        const pids = output
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean);
        for (const pid of pids) {
          this.onProgress(`Killing stale process ${pid} on port ${this.port}`);
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch (err) {
            if (err.code !== "ESRCH") {
              this.onError(`Failed to kill process ${pid}: ${err.message}`);
            }
          }
        }
        // Give the OS a moment to release the port
        await new Promise((r) => setTimeout(r, 1000));
        // Clean up the gateway's internal lockfiles so the new instance can start
        cleanupGatewayLockFiles(this.onProgress);
        return true;
      }
    } catch {
      // lsof found nothing or failed; port may have been released already
    }

    return false;
  }

  /**
   * Start the OpenClaw gateway process.
   */
  async start() {
    if (this.process) {
      this.onError("Process already running");
      return false;
    }

    // Kill any stale process occupying the gateway port
    await this.killStalePortProcess();

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
      detached: true,
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

    // Write PID file
    this.writePidFile(this.process.pid);

    // Poll until the gateway is accepting connections, then log ready.
    this.waitForReady().then((ok) => {
      if (ok && this.process && !this.stopped) {
        this.onProgress(`OpenClaw is ready on port ${this.port}`);
        this.startHealthCheck();
      } else if (!this.stopped) {
        // Grace period expired without becoming healthy; start health checks anyway
        // so the normal failure/restart logic can kick in.
        if (this.process) {
          this.startHealthCheck();
        }
      }
    });

    return true;
  }

  /**
   * Gracefully stop the OpenClaw process.
   */
  async stop(timeoutMs = 10_000) {
    this.stopped = true;
    this.stopHealthCheck();

    if (!this.process) {
      // Even without a tracked process, clean up anything on the port
      await this.killStalePortProcess();
      return;
    }

    const pid = this.process.pid;
    this.onProgress("Stopping OpenClaw...");

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.onProgress("Graceful shutdown timed out, killing process tree...");
        // Kill the entire process group (negative PID)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          this.process?.kill("SIGKILL");
        }
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

    // Clean up any orphaned children still holding the port
    await this.killStalePortProcess();
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
      await this.start();
    }
  }

  /**
   * Poll the gateway port until it accepts a TCP connection.
   * Returns true if ready within the startup grace period, false on timeout.
   */
  async waitForReady(pollMs = 1000) {
    const deadline = Date.now() + STARTUP_GRACE_PERIOD_MS;
    while (Date.now() < deadline) {
      if (!this.process || this.stopped) {
        return false;
      }
      const listening = await new Promise((resolve) => {
        const sock = net.createConnection({ port: this.port, host: "127.0.0.1" });
        sock.on("connect", () => {
          sock.destroy();
          resolve(true);
        });
        sock.on("error", () => {
          resolve(false);
        });
      });
      if (listening) {
        return true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
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
