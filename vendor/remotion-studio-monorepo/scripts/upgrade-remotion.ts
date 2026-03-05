#!/usr/bin/env -S node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawnSync } from "child_process";

type CliOptions = {
  explicitVersion?: string;
  distTag?: string;
  dryRun: boolean;
  skipInstall: boolean;
};

type PackageUpdate = {
  path: string;
  updatedDeps: string[];
};

type WorkspaceCatalogUpdate = {
  path: string;
  updatedKeys: string[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, skipInstall: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tag" && argv[i + 1]) {
      opts.distTag = argv[++i];
      continue;
    }
    if ((arg === "--to" || arg === "--version") && argv[i + 1]) {
      opts.explicitVersion = argv[++i];
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--skip-install") {
      opts.skipInstall = true;
      continue;
    }
    if (!arg.startsWith("-") && !opts.explicitVersion) {
      opts.explicitVersion = arg;
      continue;
    }
  }
  return opts;
}

function fetchRemoteVersion(tag?: string) {
  const spec = tag ? `remotion@${tag}` : "remotion";
  try {
    const raw = execSync(`npm view ${spec} version`, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    if (!raw) throw new Error("npm view returned empty string");
    return raw;
  } catch (err) {
    throw new Error(`Failed to resolve remotion version for ${spec}: ${err}`);
  }
}

function parseWorkspaceCatalogKeys(workspaceYaml: string) {
  const keys = new Set<string>();
  const lines = workspaceYaml.split(/\r?\n/);
  let inCatalog = false;

  for (const line of lines) {
    if (!inCatalog) {
      if (/^catalog:\s*$/.test(line)) {
        inCatalog = true;
      }
      continue;
    }

    if (/^[^\s#]/.test(line)) {
      inCatalog = false;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-"))
      continue;

    const match = line.match(/^\s*(['"]?)([^'"]+?)\1\s*:\s*/);
    if (match) keys.add(match[2]);
  }

  return keys;
}

function updateWorkspaceCatalog(
  targetVersion: string,
  dryRun: boolean,
): WorkspaceCatalogUpdate | null {
  const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspacePath)) return null;

  const source = fs.readFileSync(workspacePath, "utf8");
  const updatedKeys = new Set<string>();
  let next = source;

  next = next.replace(
    /^(\s*remotion:\s*)([^\s#]+)(\s*(?:#.*)?)$/m,
    (_match, prefix: string, version: string, suffix: string) => {
      if (version !== targetVersion) updatedKeys.add("remotion");
      return `${prefix}${targetVersion}${suffix}`;
    },
  );

  next = next.replace(
    /^(\s*)(['"]?)(@remotion\/[^'"]+)\2\s*:\s*([^\s#]+)(\s*(?:#.*)?)$/gm,
    (
      _match,
      indent: string,
      quote: string,
      name: string,
      version: string,
      suffix: string,
    ) => {
      if (version !== targetVersion) updatedKeys.add(name);
      return `${indent}${quote}${name}${quote}: ${targetVersion}${suffix}`;
    },
  );

  if (updatedKeys.size === 0) return null;
  if (!dryRun) fs.writeFileSync(workspacePath, next);
  return {
    path: path.relative(repoRoot, workspacePath),
    updatedKeys: Array.from(updatedKeys).sort(),
  };
}

function collectPackages(dir: string, depth = 0): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const pkg = path.join(full, "package.json");
    if (fs.existsSync(pkg)) {
      result.push(pkg);
      continue;
    }
    // Recurse to cover scopes such as packages/@scope/*
    result.push(...collectPackages(full, depth + 1));
  }
  return result;
}

function desiredRemotionSpec(
  depName: string,
  targetVersion: string,
  useCatalog: boolean,
  catalogKeys: Set<string>,
) {
  if (useCatalog && catalogKeys.has(depName)) return "catalog:";
  return targetVersion;
}

function updatePackage(
  pkgPath: string,
  targetVersion: string,
  dryRun: boolean,
  useCatalog: boolean,
  catalogKeys: Set<string>,
): PackageUpdate | null {
  const source = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(source);
  const updatedDeps = new Set<string>();
  const sections: Array<
    "dependencies" | "devDependencies" | "optionalDependencies"
  > = ["dependencies", "devDependencies", "optionalDependencies"];

  for (const section of sections) {
    const block = pkg[section];
    if (!block) continue;
    for (const depName of Object.keys(block)) {
      if (depName === "remotion" || depName.startsWith("@remotion/")) {
        const desired = desiredRemotionSpec(
          depName,
          targetVersion,
          useCatalog,
          catalogKeys,
        );
        if (block[depName] !== desired) {
          block[depName] = desired;
          updatedDeps.add(`${section}:${depName}`);
        }
      }
    }
  }

  if (updatedDeps.size === 0) return null;
  if (!dryRun) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  return {
    path: path.relative(repoRoot, pkgPath),
    updatedDeps: Array.from(updatedDeps).sort(),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targetVersion =
    opts.explicitVersion ?? fetchRemoteVersion(opts.distTag);
  console.log(`> Target Remotion version: ${targetVersion}`);

  const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  const workspaceYaml = fs.existsSync(workspacePath)
    ? fs.readFileSync(workspacePath, "utf8")
    : "";
  const catalogKeys = workspaceYaml
    ? parseWorkspaceCatalogKeys(workspaceYaml)
    : new Set<string>();
  const useCatalog = catalogKeys.size > 0 && catalogKeys.has("remotion");

  const catalogUpdate = useCatalog
    ? updateWorkspaceCatalog(targetVersion, opts.dryRun)
    : null;

  const pkgPaths = new Set<string>([path.join(repoRoot, "package.json")]);
  for (const group of ["apps", "packages"]) {
    for (const pkg of collectPackages(path.join(repoRoot, group))) {
      pkgPaths.add(pkg);
    }
  }
  const sortedPaths = Array.from(pkgPaths).sort();

  const updates: PackageUpdate[] = [];
  for (const pkgPath of sortedPaths) {
    if (!fs.existsSync(pkgPath)) continue;
    const update = updatePackage(
      pkgPath,
      targetVersion,
      opts.dryRun,
      useCatalog,
      catalogKeys,
    );
    if (update) updates.push(update);
  }

  if (!catalogUpdate && updates.length === 0) {
    console.log("No packages required changes.");
    return;
  }

  if (catalogUpdate) {
    console.log("Updated Remotion catalog entries:");
    console.log(`  - ${catalogUpdate.path}`);
    for (const key of catalogUpdate.updatedKeys) {
      console.log(`      * ${key}`);
    }
  }

  if (updates.length > 0) {
    console.log("Updated packages:");
    for (const info of updates) {
      console.log(`  - ${info.path}`);
      for (const dep of info.updatedDeps) {
        console.log(`      * ${dep}`);
      }
    }
  }

  if (opts.dryRun) {
    console.log("Dry run complete (files left untouched).");
    return;
  }

  if (!opts.skipInstall) {
    console.log("Running pnpm install to refresh lockfile...");
    const res = spawnSync("pnpm", ["install"], {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
    });
    if (res.status !== 0) {
      throw new Error(
        "pnpm install failed. Please resolve the issue and re-run.",
      );
    }
  }
}

main();
