/**
 * Ultron Voice TTS — browser-side audio playback via gateway TTS providers.
 * Calls the gateway's tts.speak method (Edge/OpenAI/ElevenLabs) and plays the returned audio.
 * Uses Web Audio API (AudioContext) to bypass CSP media-src restrictions.
 */

import type { GatewayBrowserClient } from "./gateway.ts";

const MAX_SPEECH_CHARS = 8000;

let _audioContext: AudioContext | null = null;
let _currentSource: AudioBufferSourceNode | null = null;

/** Call this on user gesture (e.g. voice toggle click) to unlock AudioContext. */
export function unlockAudio(): void {
  if (!_audioContext) {
    _audioContext = new AudioContext();
  }
  if (_audioContext.state === "suspended") {
    void _audioContext.resume();
  }
  console.log("[voice] Audio unlocked, state:", _audioContext.state);
}

export function stopVoicePlayback(): void {
  if (_currentSource) {
    try {
      _currentSource.stop();
    } catch {
      // already stopped
    }
    _currentSource = null;
  }
}

export async function speakText(
  text: string,
  client: GatewayBrowserClient | null,
  agentId?: string,
): Promise<void> {
  console.log("[voice] speakText called, text length:", text.length);
  stopVoicePlayback();

  if (!client) {
    console.warn("[voice] No gateway client, skipping TTS");
    return;
  }

  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) {
    console.log("[voice] cleaned text is empty, skipping");
    return;
  }

  // Ensure AudioContext is ready
  if (!_audioContext) {
    _audioContext = new AudioContext();
  }
  if (_audioContext.state === "suspended") {
    await _audioContext.resume();
  }

  console.log("[voice] Requesting TTS from gateway...", cleaned.substring(0, 80));
  try {
    const res = await client.request<{
      audio: string;
      mime: string;
      provider: string;
    }>("tts.speak", { text: cleaned, ...(agentId ? { agentId } : {}) });

    console.log("[voice] Got audio from provider:", res.provider, "mime:", res.mime);

    // Decode base64 to ArrayBuffer
    const binary = atob(res.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // Decode mp3/audio into AudioBuffer and play via Web Audio API
    const audioBuffer = await _audioContext.decodeAudioData(bytes.buffer);
    const source = _audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(_audioContext.destination);
    source.onended = () => {
      _currentSource = null;
    };
    _currentSource = source;
    source.start();

    console.log("[voice] Playback started, duration:", audioBuffer.duration.toFixed(1), "s");
  } catch (err) {
    console.warn("[voice] TTS failed:", err);
  }
}

function cleanTextForSpeech(text: string): string {
  let cleaned = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();

  // Truncate at sentence boundary
  if (cleaned.length > MAX_SPEECH_CHARS) {
    const truncated = cleaned.slice(0, MAX_SPEECH_CHARS);
    const lastSentence = Math.max(
      truncated.lastIndexOf(". "),
      truncated.lastIndexOf("! "),
      truncated.lastIndexOf("? "),
    );
    cleaned = lastSentence > 50 ? truncated.slice(0, lastSentence + 1) : truncated;
  }
  return cleaned;
}
