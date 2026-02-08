#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Simple model failover utility for OpenClaw sessions.
// Usage: node update/session-failover.js --sessionKey <sessionKey> --models provider1/model1,provider2/model2 --store <path/to/sessions.json> --timeout 5000

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--sessionKey" || a === "-s") {
      out.sessionKey = args[++i];
    } else if (a === "--models" || a === "-m") {
      out.models = args[++i];
    } else if (a === "--store" || a === "-f") {
      out.store = args[++i];
    } else if (a === "--timeout" || a === "-t") {
      out.timeout = Number(args[++i]) || 5000;
    }
  }
  return out;
}

function defaultStorePath() {
  // Try to find a sessions store under the repo. Fall back to ./sessions.json
  return path.resolve(process.cwd(), "sessions.json");
}

function loadStore(storePath) {
  if (!fs.existsSync(storePath)) {
    throw new Error(`Session store not found: ${storePath}`);
  }
  const raw = fs.readFileSync(storePath, "utf8");
  return JSON.parse(raw);
}

function atomicWriteFileSync(targetPath, data) {
  const dir = path.dirname(targetPath);
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

function saveStore(storePath, store) {
  atomicWriteFileSync(storePath, JSON.stringify(store, null, 2));
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

function clearAuthProfileOverrides(entry) {
  // Mirrors the cleanup in src/sessions/model-overrides.ts:52-65
  let updated = false;
  if (entry.authProfileOverride) {
    delete entry.authProfileOverride;
    updated = true;
  }
  if (entry.authProfileOverrideSource) {
    delete entry.authProfileOverrideSource;
    updated = true;
  }
  if (entry.authProfileOverrideCompactionCount !== undefined) {
    delete entry.authProfileOverrideCompactionCount;
    updated = true;
  }
  return updated;
}

function applyModelOverrideToEntry(entry, selection) {
  // Mirrors OpenClaw's applyModelOverrideToSessionEntry behaviour
  let updated = false;
  if (selection.isDefault) {
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
    }
    if (clearAuthProfileOverrides(entry)) {
      updated = true;
    }
  } else {
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
    }
    if (clearAuthProfileOverrides(entry)) {
      updated = true;
    }
  }
  if (updated) {
    entry.updatedAt = Date.now();
  }
  return { updated };
}

async function probeModel(provider, model, timeoutMs) {
  // Basic provider probes. Uses environment API keys where appropriate.
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs ?? 5000);
  try {
    if (!provider) {
      return false;
    }
    const p = provider.toLowerCase();
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
      // Local CLI backends - assume available (they are handled outside HTTP)
      clearTimeout(to);
      return true;
    }
    if (p === "minimax" || p === "minimax-portal" || p.includes("minimax")) {
      const key = process.env.MINIMAX_API_KEY || process.env.MINIMAX_KEY;
      if (!key) {
        return false;
      }
      // Attempt a generic models endpoint if present
      const endpoint = process.env.MINIMAX_API_BASE || "https://api.minimax.ai/v1";
      try {
        const res = await fetch(`${endpoint}/models/${encodeURIComponent(model)}`, {
          signal: ac.signal,
          headers: { Authorization: `Bearer ${key}` },
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    // Fallback: check for an env var for the provider's API key and assume ok if present
    const envKey = process.env[`${p.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
    clearTimeout(to);
    return Boolean(envKey);
  } catch {
    return false;
  } finally {
    clearTimeout(to);
  }
}

async function main() {
  const args = parseArgs();
  if (!args.sessionKey) {
    console.error("--sessionKey is required");
    process.exit(2);
  }
  if (!args.models) {
    console.error("--models is required (comma-separated provider/model list)");
    process.exit(2);
  }
  const timeoutMs = args.timeout ?? 5000;
  const storePath = args.store ? path.resolve(args.store) : defaultStorePath();

  const store = loadStore(storePath);
  const entry = store[args.sessionKey];
  if (!entry) {
    console.error(`Session key not found in store: ${args.sessionKey}`);
    process.exit(3);
  }

  const candidates = String(args.models)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(splitModelRef)
    .filter(Boolean);

  if (candidates.length === 0) {
    console.error("No valid model candidates provided");
    process.exit(4);
  }

  console.log(
    `Probing ${candidates.length} model(s) for session ${args.sessionKey} with ${timeoutMs}ms timeout`,
  );

  for (const cand of candidates) {
    const provider = cand.provider;
    const model = cand.model;
    process.stdout.write(`Checking ${provider}/${model} ... `);
    /* eslint-disable no-await-in-loop */
    const ok = await probeModel(provider, model, timeoutMs);
    if (ok) {
      console.log("ok");
      const applied = applyModelOverrideToEntry(entry, { provider, model, isDefault: false });
      if (applied.updated) {
        store[args.sessionKey] = entry;
        saveStore(storePath, store);
        console.log(`Applied override ${provider}/${model} to ${args.sessionKey} in ${storePath}`);
      } else {
        console.log(`No change required for ${args.sessionKey}`);
      }
      process.exit(0);
    }
    console.log("failed");
  }

  // None succeeded — reset to default by removing overrides
  const applied = applyModelOverrideToEntry(entry, { provider: "", model: "", isDefault: true });
  if (applied.updated) {
    store[args.sessionKey] = entry;
    saveStore(storePath, store);
    console.log(`No candidate succeeded — reset overrides for ${args.sessionKey}`);
    process.exit(1);
  }
  console.log(
    "No changes made (none of the candidates were available and overrides were already default)",
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(10);
  });
}
