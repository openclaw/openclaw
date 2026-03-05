#!/usr/bin/env tsx
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appsDir = path.join(repoRoot, "apps");

type SmokeCase = {
  name: string;
  args: string[];
  expectedCompositions: string[];
};

const smokeCases: SmokeCase[] = [
  {
    name: "__smoke-template-default",
    args: [],
    expectedCompositions: ["Main"],
  },
  {
    name: "__smoke-template-3d",
    args: ["-t", "3d"],
    expectedCompositions: ["Main", "LinkedParticles"],
  },
];

function cleanup(name: string) {
  const target = path.join(appsDir, name);
  fs.rmSync(target, { recursive: true, force: true });
}

function runOrThrow(command: string, args: string[], cwd: string) {
  const res = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: true,
  });

  if (res.status !== 0) {
    throw new Error(
      `Command failed (${res.status}): ${command} ${args.join(" ")}`,
    );
  }
}

function runCaptureOrThrow(command: string, args: string[], cwd: string) {
  const res = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  if (res.status !== 0) {
    const stdout = res.stdout?.toString() ?? "";
    const stderr = res.stderr?.toString() ?? "";
    throw new Error(
      `Command failed (${res.status}): ${command} ${args.join(" ")}\n${stdout}\n${stderr}`,
    );
  }

  return (res.stdout?.toString() ?? "").trim();
}

function parseCompositionIds(output: string) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.at(-1) ?? "";
  return candidate
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z0-9_-]+$/.test(token));
}

function assertIncludes(actual: string[], expected: string[], scope: string) {
  const missing = expected.filter((item) => !actual.includes(item));
  if (missing.length > 0) {
    throw new Error(
      `[${scope}] Missing compositions: ${missing.join(", ")} (actual: ${actual.join(", ")})`,
    );
  }
}

function main() {
  for (const c of smokeCases) {
    cleanup(c.name);
  }

  try {
    for (const c of smokeCases) {
      console.log(`\n[smoke] creating ${c.name}`);
      runOrThrow(
        "pnpm",
        [
          "tsx",
          "scripts/create-project.ts",
          c.name,
          "--yes",
          "--no-install",
          ...c.args,
        ],
        repoRoot,
      );

      const appPath = path.join(appsDir, c.name);
      const compositions = runCaptureOrThrow(
        "pnpm",
        [
          "--dir",
          appPath,
          "exec",
          "remotion",
          "compositions",
          "src/index.ts",
          "--quiet",
        ],
        repoRoot,
      );

      const ids = parseCompositionIds(compositions);
      assertIncludes(ids, c.expectedCompositions, c.name);
      console.log(`[smoke] ok ${c.name}: ${ids.join(", ")}`);
    }
  } finally {
    for (const c of smokeCases) {
      cleanup(c.name);
    }
  }
}

main();
