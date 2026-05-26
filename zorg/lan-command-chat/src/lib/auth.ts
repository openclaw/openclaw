import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "lan_chat_auth";
export const AUTH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

export function configuredPasswordHash() {
  return process.env.LAN_CHAT_PASSWORD_HASH?.trim() || "";
}

export function configuredAuthSecret() {
  return process.env.LAN_CHAT_AUTH_SECRET?.trim() || "";
}

export function signAuthToken(timestamp = Date.now()) {
  const secret = configuredAuthSecret();
  if (!secret) throw new Error("LAN chat auth secret is not configured");
  const issued = String(timestamp);
  const signature = createHmac("sha256", secret).update(issued).digest("base64url");
  return `v1.${base64Url(issued)}.${signature}`;
}

export function verifyPassword(password: string) {
  const encoded = configuredPasswordHash();
  const [version, iterationsRaw, salt, expected] = encoded.split(":");
  if (version !== "pbkdf2-sha256" || !iterationsRaw || !salt || !expected) return false;
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const { pbkdf2Sync } = require("node:crypto") as typeof import("node:crypto");
  const actual = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url");
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
