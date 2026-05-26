import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE = "lan_chat_auth";
const AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LAN_CHAT_PUBLIC_PATHS = new Set(["/", "/api/auth/login", "/api/chat/identity", "/api/chat/status", "/favicon.ico"]);


function base64UrlDecode(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return atob(padded);
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hasValidLogin(req: NextRequest): Promise<boolean> {
  const secret = process.env.LAN_CHAT_AUTH_SECRET?.trim();
  if (!secret) return false;
  const token = req.cookies.get(AUTH_COOKIE)?.value || "";
  const [version, issuedEncoded, signature] = token.split(".");
  if (version !== "v1" || !issuedEncoded || !signature) return false;
  const issued = base64UrlDecode(issuedEncoded);
  if (!issued || !/^\d+$/.test(issued)) return false;
  const age = Date.now() - Number.parseInt(issued, 10);
  if (age < 0 || age > AUTH_MAX_AGE_MS) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = bytesToBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(issued)));
  return expected === signature;
}

function isAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_next/") || pathname.startsWith("/assets/");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (LAN_CHAT_PUBLIC_PATHS.has(pathname) || isAssetPath(pathname)) {
    return NextResponse.next();
  }

  if (await hasValidLogin(req)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Login required" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/";
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/:path*"],
};
