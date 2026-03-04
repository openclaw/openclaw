// simple voice helper for browser recording and TTS playback

import type { GatewayBrowserClient } from "../gateway.ts";

// Minimal interface for SpeechRecognition (not yet in all TypeScript DOM libs)
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

let recognition: SpeechRecognitionLike | null = null;
let lastTranscript = "";

export async function startRecording(): Promise<void> {
  // use web speech api if available
  const win = window as unknown as Record<string, unknown>;
  const SpeechRec = (win.SpeechRecognition ?? win.webkitSpeechRecognition) as
    | SpeechRecognitionConstructor
    | undefined;
  if (SpeechRec) {
    recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.addEventListener("result", (ev: Event) => {
      const e = ev as Event & { resultIndex: number; results: SpeechRecognitionResultList };
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          lastTranscript += res[0].transcript;
        }
      }
    });
    recognition.addEventListener("error", (e: Event) => {
      console.warn("speech recognition error", e);
    });
    recognition.start();
    return;
  }
  return Promise.reject(new Error("SpeechRecognition not supported"));
}

export async function stopRecording(): Promise<string> {
  if (!recognition) {
    return Promise.reject(new Error("not recording"));
  }
  return new Promise<string>((resolve) => {
    recognition!.onend = () => {
      const t = lastTranscript;
      lastTranscript = "";
      recognition = null;
      resolve(t);
    };
    recognition!.stop();
  });
}

/**
 * Play text via TTS. Prefer gateway server conversion, fall back to browser speechSynthesis.
 */
export async function playTTS(text: string, client?: GatewayBrowserClient | null): Promise<void> {
  if (!text) {
    return;
  }
  // try server-side TTS first
  if (client) {
    try {
      const res = await client.request<{ audioPath: string }>("tts.convert", { text });
      if (res && typeof res.audioPath === "string") {
        const audio = new Audio(res.audioPath);
        await audio.play().catch((err) => {
          console.warn("audio playback failed", err);
        });
        return;
      }
    } catch (err) {
      console.warn("tts.convert failed", err);
    }
  }

  // fallback to built-in speechSynthesis
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    const utter = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utter);
  }
}
