import { NextResponse } from "next/server";

import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS, configuredAuthSecret, configuredPasswordHash, signAuthToken, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!configuredPasswordHash() || !configuredAuthSecret()) {
    return NextResponse.json({ ok: false, error: "Login is not configured" }, { status: 503 });
  }

  let password = "";
  try {
    const body = await req.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    password = "";
  }

  if (!verifyPassword(password)) {
    return NextResponse.json({ ok: false, error: "Invalid password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, signAuthToken(), {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/",
    maxAge: AUTH_MAX_AGE_SECONDS,
  });
  return res;
}
