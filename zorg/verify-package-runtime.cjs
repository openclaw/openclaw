#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const EXPECTED_CODEX_PLUGIN_SPEC = `@openclaw/codex@${pkg.version}`;

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

const codexSpecChecks = [
  ["src/commands/codex-runtime-plugin-install.ts", /CODEX_RUNTIME_PLUGIN_NPM_SPEC\s*=\s*"([^"]+)"/],
  [
    "src/commands/doctor/shared/configured-runtime-plugin-installs.ts",
    /pluginId:\s*"codex"[\s\S]*?npmSpec:\s*"([^"]+)"/,
  ],
  [
    "scripts/lib/official-external-provider-catalog.json",
    /"id":\s*"codex"[\s\S]*?"npmSpec":\s*"([^"]+)"/,
  ],
  [
    "dist/codex-runtime-plugin-install-B70xNAdC.js",
    /CODEX_RUNTIME_PLUGIN_NPM_SPEC\s*=\s*"([^"]+)"/,
  ],
  [
    "dist/configured-runtime-plugin-installs-D_FZggJS.js",
    /pluginId:\s*"codex"[\s\S]*?npmSpec:\s*"([^"]+)"/,
  ],
  [
    "dist/official-external-plugin-catalog-f6g4JsA2.js",
    /"id":\s*"codex"[\s\S]*?"npmSpec":\s*"([^"]+)"/,
  ],
];

for (const [relativePath, pattern] of codexSpecChecks) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    if (relativePath.startsWith("src/")) {
      continue;
    }
    fail(`missing packaged Codex plugin install spec file: ${relativePath}`);
    continue;
  }
  const content = fs.readFileSync(filePath, "utf8");
  const match = pattern.exec(content);
  if (!match) {
    fail(`missing Codex plugin npmSpec in ${relativePath}`);
    continue;
  }
  if (match[1] !== EXPECTED_CODEX_PLUGIN_SPEC) {
    fail(
      `${relativePath} installs ${match[1]} instead of ${EXPECTED_CODEX_PLUGIN_SPEC}; unpinned Codex installs can pull an incompatible plugin SDK`,
    );
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("[zorg-verify-package-runtime] OK");
