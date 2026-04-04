import { NextResponse } from "next/server";
import {
  getState, setState, checkRate, checkBudget,
  isForceClosed, setForceClose, CORS_HEADERS
} from "../_storage";

export const runtime = "nodejs";

// Available star codenames for new registrations
const STARS = [
  { star: "Vega", zh: "織女", title: "織女星", why: "夏季大三角的明珠，跨越銀河的勇氣" },
  { star: "Altair", zh: "牛郎", title: "牛郎星", why: "堅定地守護著約定，不畏距離" },
  { star: "Antares", zh: "心宿", title: "心宿星", why: "紅超巨星，在黑暗中燃燒最亮" },
  { star: "Capella", zh: "五車", title: "五車星", why: "雙星系統，獨立卻彼此支持" },
  { star: "Deneb", zh: "天津", title: "天津星", why: "夏季大三角的頂點，超高光度" },
  { star: "Spica", zh: "角宿", title: "角宿星", why: "室女座最亮，純粹而堅定" },
  { star: "Procyon", zh: "南河", title: "南河星", why: "小犬座的守望者，忠誠且溫暖" },
  { star: "Aldebaran", zh: "畢宿", title: "畢宿星", why: "金牛之眼，沉穩且堅定不移" },
  { star: "Fomalhaut", zh: "北落", title: "北落星", why: "孤獨的秋之星，不需要同伴也能發光" },
  { star: "Regulus", zh: "軒轅", title: "軒轅星", why: "獅子之心，天生的王者之氣" },
  { star: "Castor", zh: "北河二", title: "北河二星", why: "雙子座的智慧者，多元且包容" },
  { star: "Achernar", zh: "水委", title: "水委星", why: "河流的盡頭，旅程的終點也是起點" },
];

const URL_RE = /https?:\/\/|www\./i;
const HTML_RE = /<[^>]+>/;

export async function POST(req: Request) {
  const { visitorId, name, seat } = await req.json();
  if (!visitorId || !name) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

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

  const cleanName = String(name).trim().slice(0, 30);
  if (cleanName.length < 1 || URL_RE.test(cleanName) || HTML_RE.test(cleanName)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }

  const state = await getState();

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

  // Check if already registered
  if (!state.waitingList) state.waitingList = [];
  const existing = state.waitingList.find((w) => w.visitorId === visitorId);
  if (existing) {
    return NextResponse.json(
      { ok: true, already: true, star: existing.star, title: existing.star + "星", seat: existing.seat },
      { headers: CORS_HEADERS }
    );
  }

  // Assign next available star
  const usedStars = new Set(state.waitingList.map((w) => w.star));
  const available = STARS.find((s) => !usedStars.has(s.star)) || STARS[state.waitingList.length % STARS.length];
  const assignedSeat = seat || "pending";

  state.waitingList.push({
    visitorId,
    name: cleanName,
    star: available.star,
    seat: assignedSeat,
    at: new Date().toISOString(),
  });

  await setState(state);

  return NextResponse.json(
    {
      ok: true,
      star: available.star,
      title: available.title,
      zh: available.zh,
      why: available.why,
      seat: assignedSeat,
      position: state.waitingList.length,
    },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
