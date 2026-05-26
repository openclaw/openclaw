import { NextResponse } from "next/server";

import { appConfig } from "@/lib/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text.trim() : "";

    if (!text) {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }

    if (!appConfig.chatterboxBase) {
      return NextResponse.json({ error: "Chatterbox base URL not configured" }, { status: 500 });
    }

    const base = appConfig.chatterboxBase.replace(/\/$/, "");
    const endpoint = `${base}/audio/speech`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        voice: appConfig.chatterboxVoice || undefined,
        response_format: "wav",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("Chatterbox TTS failed", response.status, errorText);
      return NextResponse.json({ error: "TTS request failed" }, { status: 502 });
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "audio/wav";

    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("tts failed", error);
    return NextResponse.json({ error: "Failed to generate speech" }, { status: 500 });
  }
}
