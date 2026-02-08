#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Default-model failover utility for OpenClaw.
// Probes a list of candidate models and updates the global config's
// `agents.defaults.model.primary` to the first responsive model.
// Usage:
// node update/default-model-failover.js --models openai/gpt-4o,anthropic/claude-opus-4-6 --config "C:\Users\you\.openclaw\openclaw.json" --timeout 5000

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--models" || a === "-m") {
      out.models = args[++i];
    } else if (a === "--config" || a === "-c") {
      out.config = args[++i];
    } else if (a === "--timeout" || a === "-t") {
      out.timeout = Number(args[++i]) || 5000;
    } else if (a === "--backup-dir" || a === "-b") {
      out.backupDir = args[++i];
    }
  }
  return out;
}

function defaultConfigPath() {
  const home = process.env.USERPROFILE || process.env.HOME || ".";
  return path.join(home, ".openclaw", "openclaw.json");
}

function backupFile(filePath, backupDir) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(filePath);
  const dir = backupDir || path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const dest = path.join(dir, `${base}.backup-${ts}`);
  fs.copyFileSync(filePath, dest);
  return dest;
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function atomicWriteFileSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `${base}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, data, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, targetPath);
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {}
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    throw err;
  }
}

function saveJson(filePath, obj) {
  atomicWriteFileSync(filePath, JSON.stringify(obj, null, 2));
}

function splitModelRef(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return null;
  }
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

async function probeModel(provider, model, timeoutMs) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs ?? 5000);
  try {
    const p = String(provider || "").toLowerCase();
    if (p === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        return false;
      }
      const res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
        signal: ac.signal,
        headers: { Authorization: `Bearer ${key}` },
      });
      return res.ok;
    }
    if (p === "anthropic") {
      const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_0;
      if (!key) {
        return false;
      }
      const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
        signal: ac.signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      return res.ok;
    }
    if (p.endsWith("-cli") || p === "claude-cli" || p === "codex-cli") {
      clearTimeout(to);
      return true;
    }
    const envKey = process.env[`${p.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
    clearTimeout(to);
    return Boolean(envKey);
  } catch {
    return false;
  } finally {
    clearTimeout(to);
  }
}

function applyDefaultModel(cfg, provider, model) {
  if (!cfg.agents) {
    cfg.agents = {};
  }
  if (!cfg.agents.defaults) {
    cfg.agents.defaults = {};
  }
  // merge into existing object to preserve keys like fallbacks
  cfg.agents.defaults.model = {
    ...cfg.agents.defaults.model,
    primary: `${provider}/${model}`,
  };
}

async function main() {
  const args = parseArgs();
  if (!args.models) {
    console.error("--models required (comma-separated provider/model list)");
    process.exit(2);
  }
  const timeoutMs = args.timeout ?? 5000;
  const configPath = args.config ? path.resolve(args.config) : defaultConfigPath();

  const candidates = String(args.models)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(splitModelRef)
    .filter(Boolean);

  if (candidates.length === 0) {
    console.error("No valid model candidates provided");
    process.exit(3);
  }

  const cfg = loadJson(configPath) ?? {};
  const bak = backupFile(configPath, args.backupDir);
  if (bak) {
    console.log(`Backed up ${configPath} -> ${bak}`);
  }

  console.log(`Probing ${candidates.length} candidate default models with ${timeoutMs}ms timeout`);
  for (const c of candidates) {
    process.stdout.write(`Checking ${c.provider}/${c.model} ... `);
    const ok = await probeModel(c.provider, c.model, timeoutMs);
    if (ok) {
      console.log("ok");
      applyDefaultModel(cfg, c.provider, c.model);
      saveJson(configPath, cfg);
      console.log(`Updated default model in ${configPath} -> ${c.provider}/${c.model}`);
      process.exit(0);
    }
    console.log("failed");
  }

  console.log(`No candidates succeeded; leaving config unchanged${bak ? " (backup created)" : ""}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(10);
  });
}
