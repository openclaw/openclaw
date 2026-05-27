#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function envTruthy(name) {
  const value = process.env[name];
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function log(message) {
  console.error("[zorg-memorydb] " + message);
}

const installMode = String(process.env.ZORG_INSTALL_MODE || "").toLowerCase();
const existingUpgradeAllowed = envTruthy("ZORG_ALLOW_EXISTING_UPGRADE");
const skipBootstrap = envTruthy("ZORG_MEMORYDB_SKIP_BOOTSTRAP");

if (skipBootstrap) {
  log("Skipping existing-upgrade add-on bootstrap because ZORG_MEMORYDB_SKIP_BOOTSTRAP is set.");
  process.exit(0);
}

if (installMode !== "existing" || !existingUpgradeAllowed) {
  process.exit(0);
}

const scriptPath = path.join(__dirname, "install-zorg-memorydb.sh");
if (!fs.existsSync(scriptPath)) {
  console.error("[zorg-memorydb] Expected add-on bootstrap is missing: " + scriptPath);
  process.exit(1);
}

const args = [scriptPath, "--from-openclaw-install", "--install-mode", "existing"];
log("Running existing-upgrade add-on bootstrap: " + args.join(" "));

if (envTruthy("ZORG_POSTINSTALL_ADDON_DRY_RUN")) {
  log("Dry run requested; bootstrap command was not executed.");
  process.exit(0);
}

const result = spawnSync("bash", args, {
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error("[zorg-memorydb] Failed to start add-on bootstrap: " + result.error.message);
  process.exit(1);
}

process.exit(typeof result.status === "number" ? result.status : 1);
