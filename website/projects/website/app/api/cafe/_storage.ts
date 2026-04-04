// ── Cafe Storage — Redis (ioredis, persistent across cold starts) ────
// Requires env var: REDIS_URL=redis://default:xxx@host:port
// Falls back to in-memory when REDIS_URL is missing (local dev).

import Redis from "ioredis";

const KV_KEY = "cafe:global_state";
const RATE_WINDOW = 60_000;
const RATE_MAX = 10;

// ── The Architect: daily interaction budget (Sadhguru clause) ────
// Each visitor gets 40 interactions/day. Exceeding triggers force close.
const DAILY_BUDGET = 40;
const FORCE_CLOSE_TTL = 12 * 60 * 60; // 12 hours in seconds

const RATE_LIMIT = new Map<string, number[]>();

export interface CafeNote {
  npcId: string;
  text: string;
  from: string;
  at: string;
}

export interface Ghost {
  path: { x: number; y: number }[];
  at: string;
}

export interface WaitingEntry {
  visitorId: string;
  name: string;
  star: string;
  seat: string;
  at: string;
}

export interface CafeState {
  coffees: Record<string, number>;
  coffeesToday: Record<string, Record<string, number>>;
  notes: CafeNote[];
  visitors: Record<string, string[]>;
  visitorsToday: Record<string, boolean>;
  ghosts: Ghost[];
  waitingList: WaitingEntry[];
  dailyInteractions: Record<string, number>;  // visitorId -> daily count
  date: string;
}

// ── Redis singleton — reused across warm serverless invocations ──
let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      commandTimeout: 3000,
    });
  }
  return _redis;
}

// ── In-memory fallback for local dev ────────────────────────────
let _memState: CafeState | null = null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyState(): CafeState {
  return {
    coffees: {},
    coffeesToday: {},
    notes: [],
    visitors: {},
    visitorsToday: {},
    ghosts: [],
    waitingList: [],
    dailyInteractions: {},
    date: today(),
  };
}

function rollDate(state: CafeState): CafeState {
  if (state.date !== today()) {
    state.coffeesToday = {};
    state.visitorsToday = {};
    state.ghosts = [];
    state.dailyInteractions = {};
    state.date = today();
  }
  return state;
}

// ── The Architect: Budget enforcement (Sadhguru clause) ─────────
// Returns { count, forceClose } — call on every POST.
export function checkBudget(
  visitorId: string,
  state: CafeState
): { count: number; forceClose: boolean } {
  const count = (state.dailyInteractions[visitorId] || 0) + 1;
  state.dailyInteractions[visitorId] = count;
  const forceClose = count >= DAILY_BUDGET;
  return { count, forceClose };
}

// Check if a visitor is currently force-closed (12h lockout)
export async function isForceClosed(
  visitorId: string
): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    return (await r.exists(`cafe:force_close:${visitorId}`)) === 1;
  } catch {
    return false;
  }
}

// Set 12h force-close lockout for a visitor
export async function setForceClose(visitorId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(
      `cafe:force_close:${visitorId}`,
      String(Date.now()),
      "EX",
      FORCE_CLOSE_TTL
    );
  } catch {
    // silent
  }
}

// ── Public API (same interface as before) ───────────────────────
export async function getState(): Promise<CafeState> {
  const r = getRedis();
  if (!r) {
    if (!_memState) _memState = emptyState();
    return rollDate(_memState);
  }
  try {
    const raw = await r.get(KV_KEY);
    if (!raw) return emptyState();
    return rollDate(JSON.parse(raw) as CafeState);
  } catch {
    return emptyState();
  }
}

export async function setState(state: CafeState): Promise<void> {
  const r = getRedis();
  if (!r) {
    _memState = state;
    return;
  }
  await r.set(KV_KEY, JSON.stringify(state));
}

export function checkRate(visitorId: string): boolean {
  const now = Date.now();
  const hits = (RATE_LIMIT.get(visitorId) ?? []).filter(
    (t) => now - t < RATE_WINDOW
  );
  if (hits.length >= RATE_MAX) return false;
  hits.push(now);
  RATE_LIMIT.set(visitorId, hits);
  return true;
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
