import { NextResponse } from "next/server";

import { appConfig } from "@/lib/env";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function normalizeBaseUrl(value: string) {
  return (value || "https://api.openai.com/v1").replace(/\/$/, "");
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data") && !contentType.includes("application/x-www-form-urlencoded")) {
      return NextResponse.json({ error: "Multipart audio upload is required" }, { status: 400 });
    }

    const incoming = await request.formData();
    const audio = incoming.get("audio");
    const language = incoming.get("language");
    const prompt = incoming.get("prompt");

    if (!(audio instanceof File)) {
      return NextResponse.json({ error: "Audio file is required" }, { status: 400 });
    }

    if (audio.size <= 0) {
      return NextResponse.json({ error: "Audio file is empty" }, { status: 400 });
    }

    if (audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "Audio file is too large for transcription" }, { status: 413 });
    }

    if (!appConfig.openaiApiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY is not configured for transcription" }, { status: 500 });
    }

    const form = new FormData();
    form.append("file", audio, audio.name || "agent-voice.webm");
    form.append("model", appConfig.whisperModel);
    form.append("response_format", "json");
    if (typeof language === "string" && language.trim()) form.append("language", language.trim());
    if (typeof prompt === "string" && prompt.trim()) form.append("prompt", prompt.trim());

    const endpoint = `${normalizeBaseUrl(appConfig.openaiBaseUrl)}/audio/transcriptions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appConfig.openaiApiKey}`,
      },
      body: form,
    });

    const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));

    if (!response.ok) {
      const apiCode = typeof payload?.error?.code === "string" ? payload.error.code : "unknown";
      console.error("Whisper transcription failed", response.status, apiCode);
      return NextResponse.json({ error: "Whisper transcription failed" }, { status: 502 });
    }

    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!text) {
      return NextResponse.json({ error: "Whisper returned an empty transcript" }, { status: 502 });
    }

    return NextResponse.json({ text, model: appConfig.whisperModel });
  } catch (error) {
    console.error("transcription failed", error);
    return NextResponse.json({ error: "Failed to transcribe audio" }, { status: 500 });
  }
}
