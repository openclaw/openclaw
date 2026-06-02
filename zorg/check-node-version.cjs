#!/usr/bin/env node

const minimum = { major: 22, minor: 19, patch: 0 };
const recommendedMajor = 24;

function commandExists(command) {
  let result = require("child_process").spawnSync(
    "sh",
    ["-c", "command -v " + command + " >/dev/null 2>&1"],
    {
      stdio: "ignore",
    },
  );
  return result.status === 0;
}

function parseVersion(version) {
  let match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isAtLeast(version, required) {
  if (!version) {
    return false;
  }
  if (version.major !== required.major) {
    return version.major > required.major;
  }
  if (version.minor !== required.minor) {
    return version.minor > required.minor;
  }
  return version.patch >= required.patch;
}

function run(command, args, options) {
  return require("child_process").spawnSync(
    command,
    args,
    Object.assign({ stdio: "inherit" }, options || {}),
  );
}

function runShell(script) {
  return run("sh", ["-c", script]);
}

function canElevate() {
  if (process.platform === "win32") {
    return false;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return true;
  }
  return commandExists("sudo");
}

function asRoot(command) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return command;
  }
  return "sudo " + command;
}

function installNodeWithSystemPackageManager() {
  if (process.platform === "win32") {
    return false;
  }
  if (!canElevate()) {
    console.error(
      "[openclaw] Cannot auto-install Node.js because this user is not root and sudo is unavailable.",
    );
    return false;
  }

  if (commandExists("apt-get")) {
    return (
      runShell(
        [
          "set -e",
          asRoot("apt-get update"),
          asRoot("apt-get install -y ca-certificates curl gnupg"),
          "curl -fsSL https://deb.nodesource.com/setup_22.x | " + asRoot("bash -"),
          asRoot("apt-get remove -y npm libnode-dev nodejs-doc || true"),
          asRoot("apt-get install -y nodejs"),
        ].join("\n"),
      ).status === 0
    );
  }

  if (commandExists("dnf")) {
    return (
      runShell(
        [
          "set -e",
          asRoot("dnf install -y ca-certificates curl"),
          "curl -fsSL https://rpm.nodesource.com/setup_22.x | " + asRoot("bash -"),
          asRoot("dnf install -y nodejs"),
        ].join("\n"),
      ).status === 0
    );
  }

  if (commandExists("yum")) {
    return (
      runShell(
        [
          "set -e",
          asRoot("yum install -y ca-certificates curl"),
          "curl -fsSL https://rpm.nodesource.com/setup_22.x | " + asRoot("bash -"),
          asRoot("yum install -y nodejs"),
        ].join("\n"),
      ).status === 0
    );
  }

  if (commandExists("zypper")) {
    return (
      runShell(
        [
          "set -e",
          asRoot("zypper --non-interactive install ca-certificates curl"),
          "curl -fsSL https://rpm.nodesource.com/setup_22.x | " + asRoot("bash -"),
          asRoot("zypper --non-interactive install nodejs"),
        ].join("\n"),
      ).status === 0
    );
  }

  if (commandExists("apk")) {
    return (
      runShell(["set -e", asRoot("apk add --no-cache nodejs-current npm")].join("\n")).status === 0
    );
  }

  if (commandExists("pacman")) {
    return (
      runShell(["set -e", asRoot("pacman -Sy --noconfirm nodejs npm")].join("\n")).status === 0
    );
  }

  if (commandExists("brew")) {
    return run("brew", ["install", "node"]).status === 0;
  }

  console.error(
    "[openclaw] No supported package manager was found for automatic Node.js installation.",
  );
  return false;
}

function installNpmWithSystemPackageManager() {
  if (process.platform === "win32") {
    return false;
  }
  if (!canElevate() && !commandExists("brew")) {
    console.error(
      "[openclaw] Cannot auto-install npm because this user is not root and sudo is unavailable.",
    );
    return false;
  }

  if (
    commandExists("apt-get") ||
    commandExists("dnf") ||
    commandExists("yum") ||
    commandExists("zypper") ||
    commandExists("brew")
  ) {
    return installNodeWithSystemPackageManager();
  }

  if (commandExists("apk")) {
    return runShell(["set -e", asRoot("apk add --no-cache npm")].join("\n")).status === 0;
  }

  if (commandExists("pacman")) {
    return runShell(["set -e", asRoot("pacman -Sy --noconfirm npm")].join("\n")).status === 0;
  }

  console.error(
    "[openclaw] No supported package manager was found for automatic npm installation.",
  );
  return false;
}

function currentNodeVersionFromPath() {
  let result = require("child_process").spawnSync("node", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  return parseVersion(String(result.stdout || "").trim());
}

function versionToString(version) {
  if (!version) {
    return "missing";
  }
  return [version.major, version.minor, version.patch].join(".");
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function firstPathCommand(command) {
  let result = require("child_process").spawnSync("sh", ["-c", "command -v " + command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return "";
  }
  return (
    String(result.stdout || "")
      .trim()
      .split("\n")[0] || ""
  );
}

function versionOfNodeBinary(path) {
  if (!path) {
    return null;
  }
  let result = require("child_process").spawnSync(path, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return parseVersion(String(result.stdout || "").trim());
}

function repairShadowedNodePath() {
  let systemNode = "/usr/bin/node";
  let systemVersion = versionOfNodeBinary(systemNode);
  if (!isAtLeast(systemVersion, minimum)) {
    return false;
  }

  let pathNode = firstPathCommand("node");
  if (!pathNode || pathNode === systemNode || isAtLeast(versionOfNodeBinary(pathNode), minimum)) {
    return false;
  }

  let stamp = String(Date.now());
  let nodeBackup = pathNode + ".openclaw-old-node-" + stamp;
  let commands = [
    "set -e",
    "if [ -e " +
      shellQuote(pathNode) +
      " ] || [ -L " +
      shellQuote(pathNode) +
      " ]; then " +
      asRoot("mv " + shellQuote(pathNode) + " " + shellQuote(nodeBackup)) +
      "; fi",
    asRoot("ln -sf " + shellQuote(systemNode) + " " + shellQuote(pathNode)),
  ];

  ["npm", "npx"].forEach(function (binary) {
    let pathBinary = firstPathCommand(binary);
    let systemBinary = "/usr/bin/" + binary;
    if (pathBinary && pathBinary !== systemBinary) {
      let backupBinary = pathBinary + ".openclaw-old-" + binary + "-" + stamp;
      commands.push(
        "if [ -e " +
          shellQuote(systemBinary) +
          " ] || [ -L " +
          shellQuote(systemBinary) +
          " ]; then " +
          "if [ -e " +
          shellQuote(pathBinary) +
          " ] || [ -L " +
          shellQuote(pathBinary) +
          " ]; then " +
          asRoot("mv " + shellQuote(pathBinary) + " " + shellQuote(backupBinary)) +
          "; fi; " +
          asRoot("ln -sf " + shellQuote(systemBinary) + " " + shellQuote(pathBinary)) +
          "; fi",
      );
    }
  });

  if (runShell(commands.join("\n")).status === 0) {
    console.error(
      "[openclaw] Repaired PATH so NodeSource Node.js is used before an older shadowing node binary.",
    );
    return true;
  }
  return false;
}

function shouldAutoInstall() {
  if (
    process.env.OPENCLAW_AUTO_INSTALL_NODE === "0" ||
    process.env.OPENCLAW_SKIP_NODE_AUTO_INSTALL === "1"
  ) {
    return false;
  }
  let lifecycle = String(process.env.npm_lifecycle_event || "");
  return lifecycle === "preinstall" || process.env.OPENCLAW_AUTO_INSTALL_NODE === "1";
}

function envTruthy(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ""));
}

function isGlobalNpmLifecycle() {
  return envTruthy("npm_config_global") || envTruthy("NPM_CONFIG_GLOBAL");
}

function existingOpenClawBinary() {
  if (process.platform === "win32") {
    return "";
  }
  return firstPathCommand("openclaw");
}

function failClosedOnAccidentalExistingInstallUpgrade() {
  let lifecycle = String(process.env.npm_lifecycle_event || "");
  if (lifecycle !== "preinstall" || !isGlobalNpmLifecycle()) {
    return;
  }
  if (process.env.ZORG_INSTALL_MODE === "existing" || envTruthy("ZORG_ALLOW_EXISTING_UPGRADE")) {
    return;
  }
  let existing = existingOpenClawBinary();
  if (!existing) {
    return;
  }
  console.error("[openclaw] Existing host OpenClaw binary detected: " + existing);
  console.error(
    "[openclaw] Refusing to treat this direct GitHub npm command as a first-run install because it would upgrade an existing host install.",
  );
  console.error(
    "[openclaw] For a clean first-run install, remove or isolate the existing host install first, then install OpenClaw before applying Zorg MemoryDB and LAN command chat.",
  );
  console.error(
    "[openclaw] To intentionally repair an existing host install, rerun with ZORG_INSTALL_MODE=existing ZORG_ALLOW_EXISTING_UPGRADE=1.",
  );
  process.exit(3);
}

function existingUpgradeEnvPrefix() {
  if (process.env.ZORG_INSTALL_MODE === "existing" || envTruthy("ZORG_ALLOW_EXISTING_UPGRADE")) {
    return "ZORG_INSTALL_MODE=existing ZORG_ALLOW_EXISTING_UPGRADE=1 ";
  }
  return "";
}

function printManualInstallHelp() {
  console.error(
    [
      "[openclaw] Node.js " + process.version + " is too old for this package.",
      "[openclaw] Required: Node.js >=22.19.0; recommended: Node.js " + recommendedMajor + ".",
      "[openclaw] On fresh Linux hosts, use the Zorg MemoryDB installer first so Node is repaired before npm evaluates OpenClaw dependencies.",
      "[openclaw] Direct npm can only auto-repair Node when npm runs this lifecycle script with root/sudo privileges.",
      "[openclaw] If auto-repair is unavailable on this OS/user, run:",
      "[openclaw]   curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/StefRush2099/Zorg_MemoryDB/main/scripts/install.sh | bash",
      "[openclaw] Then rerun the npm install after node --version reports v22.19.0 or newer.",
    ].join("\n"),
  );
}

function printRepairedRuntimeRetryHelp(repaired) {
  let npm = firstPathCommand("npm") || "npm";
  console.error(
    [
      "[openclaw] Node.js prerequisite repaired; node on PATH is now " +
        versionToString(repaired) +
        ".",
      "[openclaw] The current npm process was started under " +
        process.version +
        ", so it cannot safely continue this install.",
      "[openclaw] Rerun the same install command now that node/npm have been repaired:",
      "[openclaw]   " +
        existingUpgradeEnvPrefix() +
        npm +
        " install -g --install-links=true git+https://github.com/StefRush2099/Zorg_MemoryDB.git",
    ].join("\n"),
  );
}

function printManualNpmInstallHelp() {
  console.error(
    [
      "[openclaw] npm is missing, but this package install requires npm to finish.",
      "[openclaw] On fresh Linux hosts, the direct npm install now tries to repair npm automatically during preinstall.",
      "[openclaw] If auto-repair is unavailable on this OS/user, install npm with your OS package manager, then rerun the npm install.",
    ].join("\n"),
  );
}

function ensureNpmAvailable() {
  if (commandExists("npm")) {
    return true;
  }
  if (shouldAutoInstall()) {
    console.error("[openclaw] npm is missing; attempting automatic npm repair before continuing.");
    if (installNpmWithSystemPackageManager() && commandExists("npm")) {
      console.error("[openclaw] npm prerequisite repaired.");
      return true;
    }
    console.error("[openclaw] Automatic npm repair did not leave npm on PATH.");
  }
  printManualNpmInstallHelp();
  return false;
}

let current = parseVersion(process.version);
failClosedOnAccidentalExistingInstallUpgrade();
if (!isAtLeast(current, minimum)) {
  if (shouldAutoInstall()) {
    console.error(
      "[openclaw] Node.js " +
        process.version +
        " is too old; attempting automatic Node.js >=22.19.0 install.",
    );
    if (installNodeWithSystemPackageManager()) {
      repairShadowedNodePath();
      let repaired = currentNodeVersionFromPath();
      if (isAtLeast(repaired, minimum)) {
        printRepairedRuntimeRetryHelp(repaired);
        process.exit(86);
      }
      console.error(
        "[openclaw] Automatic Node.js install completed, but node on PATH is still below v22.19.0.",
      );
    }
  }
  printManualInstallHelp();
  process.exit(1);
}
if (!ensureNpmAvailable()) {
  process.exit(1);
}
