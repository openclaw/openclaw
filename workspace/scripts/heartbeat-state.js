#!/usr/bin/env node
/**
 * Heartbeat state cache and notification throttle.
 *
 * Migrated from heartbeat_state.py → JS (統一語言)
 *
 * Usage (CLI):
 *   node heartbeat-state.js should-run <task> <min_interval_sec>
 *   node heartbeat-state.js record <task> ok|fail [--error msg] [--duration ms]
 *   node heartbeat-state.js should-notify <fingerprint> <cooldown_sec>
 *   node heartbeat-state.js record-notify <fingerprint> [--note msg]
 *
 * Usage (import):
 *   import { shouldRun, record, shouldNotify, recordNotify } from "./heartbeat-state.js";
 */

import { readFileSync, writeFileSync, openSync, closeSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const TPE_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8
const STATE_PATH = resolve(
  process.env.HEARTBEAT_STATE || `${process.env.HOME}/clawd/memory/heartbeat-state.json`,
);

function nowTPE() {
  return new Date(Date.now() + TPE_OFFSET_MS);
}

function iso(dt) {
  return dt.toISOString();
}

function parseTs(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function defaultState() {
  return {
    meta: { version: 2, updated_at: iso(nowTPE()) },
    tasks: {},
    events: { fingerprints: {} },
    lastSummary: null,
    lastChecks: {
      email: null,
      calendar: null,
      weather: null,
      telegram: null,
      pipelines: null,
      sessions: null,
    },
  };
}

function loadState() {
  try {
    const raw = readFileSync(STATE_PATH, "utf-8").trim();
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    data.meta ??= { version: 2, updated_at: iso(nowTPE()) };
    data.tasks ??= {};
    data.events ??= { fingerprints: {} };
    data.lastSummary ??= null;
    data.lastChecks ??= {
      email: null,
      calendar: null,
      weather: null,
      telegram: null,
      pipelines: null,
      sessions: null,
    };
    return data;
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  state.meta ??= {};
  state.meta.updated_at = iso(nowTPE());
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Check if a task should run based on throttle interval.
 * @param {string} task
 * @param {number} minIntervalSec
 * @returns {boolean}
 */
export function shouldRun(task, minIntervalSec) {
  const state = loadState();
  const info = state.tasks[task] ?? {};
  const last = parseTs(info.last_run);
  const now = nowTPE();

  if (last && (now.getTime() - last.getTime()) / 1000 < minIntervalSec) {
    saveState(state);
    return false;
  }

  info.fail_count ??= 0;
  info.last_run = iso(now);
  state.tasks[task] = info;
  saveState(state);
  return true;
}

/**
 * Record task execution result.
 * @param {string} task
 * @param {boolean} ok
 * @param {{ error?: string, durationMs?: number }} [opts]
 */
export function record(task, ok, opts = {}) {
  const state = loadState();
  const info = state.tasks[task] ?? {};
  const now = nowTPE();

  info.last_run = iso(now);
  if (ok) {
    info.last_ok = iso(now);
    info.last_error = null;
  } else {
    info.last_fail = iso(now);
    info.last_error = opts.error || "unknown";
    info.fail_count = (info.fail_count ?? 0) + 1;
  }
  if (opts.durationMs != null) {
    info.last_duration_ms = Number(opts.durationMs);
  }
  state.tasks[task] = info;
  saveState(state);
}

/**
 * Check if a notification should fire based on cooldown.
 * @param {string} fingerprint
 * @param {number} cooldownSec
 * @returns {boolean}
 */
export function shouldNotify(fingerprint, cooldownSec) {
  const state = loadState();
  const events = (state.events.fingerprints ??= {});
  const info = events[fingerprint] ?? {};
  const last = parseTs(info.last_notified);
  const now = nowTPE();

  if (last && (now.getTime() - last.getTime()) / 1000 < cooldownSec) {
    saveState(state);
    return false;
  }

  info.last_notified = iso(now);
  info.count = (info.count ?? 0) + 1;
  events[fingerprint] = info;
  saveState(state);
  return true;
}

/**
 * Record that a notification was sent.
 * @param {string} fingerprint
 * @param {string} [note]
 */
export function recordNotify(fingerprint, note) {
  const state = loadState();
  const events = (state.events.fingerprints ??= {});
  const info = events[fingerprint] ?? {};
  info.last_notified = iso(nowTPE());
  info.count = (info.count ?? 0) + 1;
  if (note) info.note = note;
  events[fingerprint] = info;
  saveState(state);
}

// ── CLI ──
const args = process.argv.slice(2);
if (args.length) {
  const cmd = args[0];

  if (cmd === "should-run" && args.length >= 3) {
    const ok = shouldRun(args[1], Number(args[2]));
    console.log(ok ? "run" : "skip");
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "record" && args.length >= 3) {
    const ok = args[2] === "ok";
    let error, duration;
    for (let i = 3; i < args.length; i++) {
      if (args[i] === "--error" && args[i + 1]) {
        error = args[++i];
        continue;
      }
      if (args[i] === "--duration" && args[i + 1]) {
        duration = args[++i];
        continue;
      }
    }
    record(args[1], ok, { error, durationMs: duration });
    process.exit(0);
  }

  if (cmd === "should-notify" && args.length >= 3) {
    const ok = shouldNotify(args[1], Number(args[2]));
    console.log(ok ? "notify" : "skip");
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "record-notify" && args.length >= 2) {
    let note;
    const idx = args.indexOf("--note");
    if (idx !== -1 && args[idx + 1]) note = args[idx + 1];
    recordNotify(args[1], note);
    process.exit(0);
  }

  console.log(`Usage:
  heartbeat-state.js should-run <task> <min_interval_sec>
  heartbeat-state.js record <task> ok|fail [--error msg] [--duration ms]
  heartbeat-state.js should-notify <fingerprint> <cooldown_sec>
  heartbeat-state.js record-notify <fingerprint> [--note msg]`);
  process.exit(2);
}
