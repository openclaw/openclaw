#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function fail(message) {
  console.error("[zorg-verify-package-runtime] " + message);
  process.exitCode = 1;
}

for (const [subpath, target] of Object.entries(pkg.exports || {})) {
  if (!subpath.startsWith("./plugin-sdk/")) {
    continue;
  }
  for (const key of ["default", "types"]) {
    const rel = typeof target === "string" ? target : target && target[key];
    if (!rel) {
      continue;
    }
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) {
      fail(`${subpath} ${key} points to missing file ${rel}`);
    }
  }
}

const harnessRuntimePath = path.join(
  root,
  pkg.exports["./plugin-sdk/agent-harness-runtime"].default,
);
const taskRuntimePath = path.join(
  root,
  pkg.exports["./plugin-sdk/agent-harness-task-runtime"].default,
);
const harnessRuntime = fs.readFileSync(harnessRuntimePath, "utf8");
const taskRuntime = fs.readFileSync(taskRuntimePath, "utf8");

if (!/hasBeforeToolCallPolicy/.test(harnessRuntime)) {
  fail("openclaw/plugin-sdk/agent-harness-runtime does not expose hasBeforeToolCallPolicy");
}

if (!/createAgentHarnessTaskRuntime/.test(taskRuntime)) {
  fail(
    "openclaw/plugin-sdk/agent-harness-task-runtime does not expose createAgentHarnessTaskRuntime",
  );
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("[zorg-verify-package-runtime] OK");
