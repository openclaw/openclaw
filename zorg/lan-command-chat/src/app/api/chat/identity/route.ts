import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";

import { getIdentityPath } from "@/lib/paths";

export const runtime = "nodejs";

function extractName(markdown: string): string | null {
  const match = markdown.match(/^\s*-\s*\*\*Name:\*\*\s*(.+?)\s*$/im);
  if (!match) return null;
  const value = match[1]?.trim();
  return value ? value : null;
}

export async function GET() {
  try {
    const raw = await readFile(getIdentityPath(), "utf8");
    const name = extractName(raw) ?? "Assistant";
    return NextResponse.json({ name });
  } catch (error) {
    console.error("identity failed", error);
    return NextResponse.json({ error: "Failed to load identity" }, { status: 500 });
  }
}
