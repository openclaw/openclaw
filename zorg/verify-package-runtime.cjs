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
const postinstallUpgradePath = path.join(root, "zorg/postinstall-existing-upgrade.cjs");

if (!/hasBeforeToolCallPolicy/.test(harnessRuntime)) {
  fail("openclaw/plugin-sdk/agent-harness-runtime does not expose hasBeforeToolCallPolicy");
}

if (!/createAgentHarnessTaskRuntime/.test(taskRuntime)) {
  fail(
    "openclaw/plugin-sdk/agent-harness-task-runtime does not expose createAgentHarnessTaskRuntime",
  );
}

if (!fs.existsSync(postinstallUpgradePath)) {
  fail(
    "missing existing-upgrade postinstall bootstrap wrapper: zorg/postinstall-existing-upgrade.cjs",
  );
} else {
  const postinstallUpgrade = fs.readFileSync(postinstallUpgradePath, "utf8");
  if (
    !/ZORG_INSTALL_MODE/.test(postinstallUpgrade) ||
    !/ZORG_ALLOW_EXISTING_UPGRADE/.test(postinstallUpgrade)
  ) {
    fail(
      "existing-upgrade postinstall wrapper is not gated by ZORG_INSTALL_MODE and ZORG_ALLOW_EXISTING_UPGRADE",
    );
  }
  if (!/install-zorg-memorydb\.sh/.test(postinstallUpgrade)) {
    fail("existing-upgrade postinstall wrapper does not invoke install-zorg-memorydb.sh");
  }
}

if (
  !/zorg\/postinstall-existing-upgrade\.cjs/.test((pkg.scripts && pkg.scripts.postinstall) || "")
) {
  fail("package postinstall does not run zorg/postinstall-existing-upgrade.cjs");
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("[zorg-verify-package-runtime] OK");
