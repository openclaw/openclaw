// ── Cafe ↔ LINE Bridge ─────────────────────────────────────────────────────
// POST  — cafe events → LINE push notify (visitor_arrived, coffee_sent, note_left)
// GET   — cafe state summary for LINE bot queries
//
// LINE failures are silenced; cafe operation is never blocked.

import { NextResponse } from "next/server";
import { getState, CORS_HEADERS } from "../_storage";

export const runtime = "nodejs";

// ── Supported event types ────────────────────────────────────────
type CafeEventType = "visitor_arrived" | "coffee_sent" | "note_left";

interface CafeEvent {
  type: CafeEventType;
  visitorId?: string;
  npcId?: string;
  text?: string;   // for note_left
}

// ── LINE push helper (fire-and-forget, never throws) ─────────────
async function pushToLine(message: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const target = process.env.LINE_NOTIFY_TARGET_ID; // userId or groupId to push to
  if (!token || !target) return;

  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: target,
        messages: [{ type: "text", text: message }],
      }),
    });
  } catch {
    // silent — LINE down must not affect cafe
  }
}

// ── Build a human-readable LINE message for each event ───────────
function buildMessage(event: CafeEvent): string {
  switch (event.type) {
    case "visitor_arrived":
      return `☕ 有訪客來到思考者咖啡廳了\nID: ${event.visitorId ?? "unknown"}`;
    case "coffee_sent":
      return `☕ 有人請了一杯咖啡\nNPC: ${event.npcId ?? "?"} ← ${event.visitorId ?? "?"}`;
    case "note_left":
      return `📝 留言板新訊息\nNPC: ${event.npcId ?? "?"}\n內容: ${event.text ?? ""}`;
    default:
      return `[cafe] 未知事件`;
  }
}

// ── POST /api/cafe/bridge ─────────────────────────────────────────
export async function POST(req: Request) {
  let event: CafeEvent;
  try {
    event = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const allowed: CafeEventType[] = ["visitor_arrived", "coffee_sent", "note_left"];
  if (!allowed.includes(event.type)) {
    return NextResponse.json({ error: "unknown event type" }, { status: 400 });
  }

  const message = buildMessage(event);

  // Fire push to LINE — never awaited in a blocking sense; errors swallowed
  pushToLine(message).catch(() => {});

  return NextResponse.json({ ok: true, dispatched: event.type }, { headers: CORS_HEADERS });
}

// ── GET /api/cafe/bridge — state summary for LINE bot ─────────────
export async function GET() {
  try {
    const state = await getState();

    const visitorsToday = Object.keys(state.visitorsToday).length;

    // Sum all coffees sent today (across all NPCs and visitors)
    const coffeesToday = Object.values(state.coffeesToday).reduce((total, npcMap) => {
      return total + Object.values(npcMap).reduce((a, b) => a + b, 0);
    }, 0);

    // Latest note (if any)
    const latestNote = state.notes.length > 0
      ? state.notes[state.notes.length - 1]
      : null;

    const summary = {
      visitors_today: visitorsToday,
      coffees_today: coffeesToday,
      total_notes: state.notes.length,
      latest_note: latestNote
        ? { npcId: latestNote.npcId, text: latestNote.text, at: latestNote.at }
        : null,
      cafe_url: "https://thinker.cafe/cafe",
    };

    return NextResponse.json(summary, { headers: CORS_HEADERS });
  } catch {
    return NextResponse.json({ error: "state unavailable" }, { status: 503 });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
