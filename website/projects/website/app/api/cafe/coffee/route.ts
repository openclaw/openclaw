import { NextResponse } from "next/server";
import {
  getState, setState, checkRate, checkBudget,
  isForceClosed, setForceClose, CORS_HEADERS
} from "../_storage";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { npcId, visitorId } = await req.json();
  if (!npcId || !visitorId) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  // Architect: check force close lockout
  if (await isForceClosed(visitorId)) {
    return NextResponse.json(
      { error: "cafe closed", forceClose: true,
        farewell: "今天的營業時間結束了。外面的風很舒服，去走走吧。我們明天見。" },
      { status: 200, headers: CORS_HEADERS }
    );
  }

  if (!checkRate(visitorId)) {
    return NextResponse.json({ error: "rate limit" }, { status: 429 });
  }

  const state = await getState();

  // Architect: budget check
  const budget = checkBudget(visitorId, state);
  if (budget.forceClose) {
    await setForceClose(visitorId);
    await setState(state);
    return NextResponse.json(
      { forceClose: true,
        farewell: "今天的營業時間結束了。外面的風很舒服，去走走吧。我們明天見。" },
      { headers: CORS_HEADERS }
    );
  }

  state.coffees[npcId] = (state.coffees[npcId] ?? 0) + 1;

  if (!state.coffeesToday[npcId]) state.coffeesToday[npcId] = {};
  state.coffeesToday[npcId][visitorId] =
    (state.coffeesToday[npcId][visitorId] ?? 0) + 1;

  const today = new Date().toISOString().slice(0, 10);
  const visits = state.visitors[visitorId] ?? [];
  if (!visits.includes(today)) visits.push(today);
  state.visitors[visitorId] = visits;
  state.visitorsToday[visitorId] = true;

  await setState(state);

  const todayTotal = Object.values(state.coffeesToday[npcId] ?? {}).reduce(
    (a, b) => a + b,
    0
  );
  return NextResponse.json(
    { total: state.coffees[npcId], today: todayTotal, budgetUsed: budget.count },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
