/**
 * Build Manager
 *
 * Manages versioned builds of OpenClaw indexed by git commit hash.
 * Builds are stored in a .builds/ directory (gitignored) with a
 * "current" symlink pointing to the active build.
 *
 * Directory layout:
 *   .builds/
 *     abc1234/          # full commit hash directory
 *       dist/           # compiled output
 *       node_modules/   # dependencies (copied or linked)
 *       package.json    # manifest snapshot
 *       openclaw.mjs    # entry point
 *       build-info.json # metadata about the build
 *     def5678/
 *       ...
 *     current -> abc1234/  # symlink to active build
 */

import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_BUILDS = 32;

export function resolveRepoRoot(from = import.meta.dirname) {
  let dir = from;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not find git repository root");
}

export function resolveBuildsDir(repoRoot) {
  return path.join(repoRoot, ".builds");
}

export function getCurrentCommitHash(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
}

export function getShortHash(fullHash) {
  return fullHash.slice(0, 8);
}

export function getCurrentBranch(repoRoot) {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
}

export function getCommitMessage(repoRoot, hash) {
  return execFileSync("git", ["log", "-1", "--format=%s", hash], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
}

export function getCommitTimestamp(repoRoot, hash) {
  return execFileSync("git", ["log", "-1", "--format=%cI", hash], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
}

/**
 * Check if a build exists for a given commit hash.
 */
export function buildExists(repoRoot, commitHash) {
  const buildDir = path.join(resolveBuildsDir(repoRoot), commitHash);
  const infoFile = path.join(buildDir, "build-info.json");
  return fs.existsSync(infoFile);
}

/**
 * Get the currently active build's commit hash (what "current" symlink points to).
 */
export function getActiveBuild(repoRoot) {
  const currentLink = path.join(resolveBuildsDir(repoRoot), "current");
  try {
    const target = fs.readlinkSync(currentLink);
    return path.basename(target);
  } catch {
    return null;
  }
}

/**
 * List all builds sorted by build time (newest first).
 */
export function listBuilds(repoRoot) {
  const buildsDir = resolveBuildsDir(repoRoot);
  if (!fs.existsSync(buildsDir)) {
    return [];
  }

  const entries = fs.readdirSync(buildsDir, { withFileTypes: true });
  const builds = [];

  for (const entry of entries) {
    if (entry.name === "current") continue;
    if (!entry.isDirectory()) continue;

    const infoPath = path.join(buildsDir, entry.name, "build-info.json");
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
      builds.push({
        commitHash: entry.name,
        ...info,
      });
    } catch {
      // Incomplete build, skip
    }
  }

  builds.sort((a, b) => new Date(b.builtAt).getTime() - new Date(a.builtAt).getTime());
  return builds;
}

/**
 * Pull latest changes from remote.
 * Returns { updated, beforeHash, afterHash }.
 */
export function pullLatest(repoRoot, { branch = "main", remote = "origin" } = {}) {
  const beforeHash = getCurrentCommitHash(repoRoot);

  // Fetch first
  execFileSync("git", ["fetch", remote, branch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  // Check if there are new commits
  const remoteHash = execFileSync("git", ["rev-parse", `${remote}/${branch}`], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();

  if (remoteHash === beforeHash) {
    return { updated: false, beforeHash, afterHash: beforeHash };
  }

  // Fast-forward merge
  execFileSync("git", ["merge", "--ff-only", `${remote}/${branch}`], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  const afterHash = getCurrentCommitHash(repoRoot);
  return { updated: true, beforeHash, afterHash };
}

/**
 * Build a specific commit. The commit must already be checked out.
 * Returns build info object.
 */
export function buildCommit(repoRoot, commitHash, { onProgress } = {}) {
  const buildsDir = resolveBuildsDir(repoRoot);
  const buildDir = path.join(buildsDir, commitHash);

  // Create builds directory
  fs.mkdirSync(buildDir, { recursive: true });

  const shortHash = getShortHash(commitHash);
  const startTime = Date.now();

  onProgress?.(`Building ${shortHash}...`);

  // Step 1: Install dependencies
  onProgress?.(`[${shortHash}] Installing dependencies...`);
  try {
    execSync("pnpm install --frozen-lockfile", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    });
  } catch (err) {
    // Try without frozen lockfile as fallback
    onProgress?.(`[${shortHash}] Retrying dependency install...`);
    execSync("pnpm install", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    });
  }

  // Step 2: Build
  onProgress?.(`[${shortHash}] Compiling TypeScript...`);
  execSync("pnpm run build", {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 300_000,
  });

  // Step 3: Copy build artifacts to versioned directory
  onProgress?.(`[${shortHash}] Copying build artifacts...`);

  // Copy dist/
  const srcDist = path.join(repoRoot, "dist");
  const destDist = path.join(buildDir, "dist");
  fs.cpSync(srcDist, destDist, { recursive: true });

  // Copy essential files
  const filesToCopy = ["openclaw.mjs", "package.json", "tsdown.config.ts"];
  for (const file of filesToCopy) {
    const src = path.join(repoRoot, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(buildDir, file));
    }
  }

  // Copy node_modules (symlink to save space if on same filesystem)
  const srcModules = path.join(repoRoot, "node_modules");
  const destModules = path.join(buildDir, "node_modules");
  try {
    // Try symlink first (much faster, saves disk space)
    fs.symlinkSync(srcModules, destModules);
  } catch {
    // Fall back to copy if symlink fails
    onProgress?.(`[${shortHash}] Copying node_modules (this may take a while)...`);
    fs.cpSync(srcModules, destModules, { recursive: true });
  }

  // Copy skills/ directory
  const srcSkills = path.join(repoRoot, "skills");
  const destSkills = path.join(buildDir, "skills");
  if (fs.existsSync(srcSkills)) {
    fs.cpSync(srcSkills, destSkills, { recursive: true });
  }

  // Copy extensions/ directory
  const srcExtensions = path.join(repoRoot, "extensions");
  const destExtensions = path.join(buildDir, "extensions");
  if (fs.existsSync(srcExtensions)) {
    fs.cpSync(srcExtensions, destExtensions, { recursive: true });
  }

  // Copy ui/ build assets if they exist
  const srcUiDist = path.join(repoRoot, "ui", "dist");
  const destUiDir = path.join(buildDir, "ui");
  if (fs.existsSync(srcUiDist)) {
    fs.mkdirSync(destUiDir, { recursive: true });
    fs.cpSync(srcUiDist, path.join(destUiDir, "dist"), { recursive: true });
  }

  const durationMs = Date.now() - startTime;
  const branch = getCurrentBranch(repoRoot);
  const commitMessage = getCommitMessage(repoRoot, commitHash);
  const commitTimestamp = getCommitTimestamp(repoRoot, commitHash);

  // Write build info
  const buildInfo = {
    commitHash,
    shortHash,
    branch,
    commitMessage,
    commitTimestamp,
    builtAt: new Date().toISOString(),
    durationMs,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  fs.writeFileSync(
    path.join(buildDir, "build-info.json"),
    JSON.stringify(buildInfo, null, 2) + "\n",
  );

  onProgress?.(`[${shortHash}] Build complete in ${(durationMs / 1000).toFixed(1)}s`);

  return buildInfo;
}

/**
 * Switch the "current" symlink to point to a specific build.
 * Returns the previous active build hash (or null).
 */
export function activateBuild(repoRoot, commitHash) {
  const buildsDir = resolveBuildsDir(repoRoot);
  const buildDir = path.join(buildsDir, commitHash);
  const currentLink = path.join(buildsDir, "current");

  if (!fs.existsSync(path.join(buildDir, "build-info.json"))) {
    throw new Error(`Build ${getShortHash(commitHash)} does not exist`);
  }

  const previousHash = getActiveBuild(repoRoot);

  // Atomic symlink swap: create temp link, then rename over the old one
  const tmpLink = currentLink + ".tmp";
  try {
    fs.unlinkSync(tmpLink);
  } catch {
    // OK if it doesn't exist
  }

  fs.symlinkSync(commitHash, tmpLink);
  fs.renameSync(tmpLink, currentLink);

  return previousHash;
}

/**
 * Remove old builds, keeping the most recent maxBuilds and the active one.
 */
export function pruneBuilds(repoRoot, maxBuilds = MAX_BUILDS) {
  const builds = listBuilds(repoRoot);
  const active = getActiveBuild(repoRoot);
  const buildsDir = resolveBuildsDir(repoRoot);

  if (builds.length <= maxBuilds) {
    return [];
  }

  const toRemove = builds.slice(maxBuilds).filter((b) => b.commitHash !== active);

  const removed = [];
  for (const build of toRemove) {
    const buildDir = path.join(buildsDir, build.commitHash);
    try {
      fs.rmSync(buildDir, { recursive: true, force: true });
      removed.push(build.commitHash);
    } catch (err) {
      console.error(`Failed to remove build ${getShortHash(build.commitHash)}: ${err.message}`);
    }
  }

  return removed;
}

/**
 * Full build pipeline: pull, build if needed, activate, prune.
 * Returns { action, commitHash, buildInfo, previousHash }.
 */
export async function buildAndActivate(
  repoRoot,
  {
    pull = true,
    force = false,
    branch = "main",
    remote = "origin",
    maxBuilds = MAX_BUILDS,
    onProgress,
  } = {},
) {
  // Step 1: Pull latest
  let pullResult = null;
  if (pull) {
    onProgress?.("Pulling latest changes...");
    pullResult = pullLatest(repoRoot, { branch, remote });
    if (pullResult.updated) {
      onProgress?.(
        `Updated: ${getShortHash(pullResult.beforeHash)} -> ${getShortHash(pullResult.afterHash)}`,
      );
    } else {
      onProgress?.("Already up to date");
    }
  }

  const commitHash = getCurrentCommitHash(repoRoot);

  // Step 2: Check if build exists
  if (!force && buildExists(repoRoot, commitHash)) {
    const active = getActiveBuild(repoRoot);
    if (active === commitHash) {
      onProgress?.(`Build ${getShortHash(commitHash)} already active`);
      return { action: "noop", commitHash, buildInfo: null, previousHash: active };
    }
    // Build exists but isn't active; activate it
    const previousHash = activateBuild(repoRoot, commitHash);
    onProgress?.(`Activated existing build ${getShortHash(commitHash)}`);
    return { action: "activated", commitHash, buildInfo: null, previousHash };
  }

  // Step 3: Build
  const buildInfo = buildCommit(repoRoot, commitHash, { onProgress });

  // Step 4: Activate
  const previousHash = activateBuild(repoRoot, commitHash);
  onProgress?.(`Activated ${getShortHash(commitHash)}`);

  // Step 5: Prune old builds
  const pruned = pruneBuilds(repoRoot, maxBuilds);
  if (pruned.length > 0) {
    onProgress?.(`Pruned ${pruned.length} old build(s)`);
  }

  return { action: "built", commitHash, buildInfo, previousHash };
}

/**
 * Rollback to the previously active build.
 * If no previous build is specified, activates the second-most-recent build.
 */
export function rollback(repoRoot, targetHash) {
  const active = getActiveBuild(repoRoot);

  if (!targetHash) {
    const builds = listBuilds(repoRoot);
    const candidates = builds.filter((b) => b.commitHash !== active);
    if (candidates.length === 0) {
      throw new Error("No previous build available for rollback");
    }
    targetHash = candidates[0].commitHash;
  }

  if (!buildExists(repoRoot, targetHash)) {
    throw new Error(`Rollback target ${getShortHash(targetHash)} does not exist`);
  }

  const previousHash = activateBuild(repoRoot, targetHash);
  return { from: previousHash, to: targetHash };
}
