// simple voice helper for browser recording and TTS playback

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
// true once the browser fires onend (natural timeout or explicit stop)
let recognitionEnded = false;

export async function startRecording(
  onInterim?: (text: string) => void,
  onEnd?: (errorCode?: string) => void,
): Promise<void> {
  const win = window as unknown as Record<string, unknown>;
  const SpeechRec = (win.SpeechRecognition ?? win.webkitSpeechRecognition) as
    | SpeechRecognitionConstructor
    | undefined;
  if (SpeechRec) {
    recognition = new SpeechRec();
    lastTranscript = "";
    recognitionEnded = false;
    recognition.continuous = true;
    recognition.interimResults = true;
    // Use the browser language so recognition matches what the user is speaking
    (recognition as unknown as { lang: string }).lang = navigator.language || "en-US";
    let lastErrorCode: string | undefined;
    recognition.addEventListener("result", (ev: Event) => {
      const e = ev as Event & { resultIndex: number; results: SpeechRecognitionResultList };
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          lastTranscript += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }
      onInterim?.(lastTranscript + interim);
    });
    recognition.addEventListener("error", (e: Event) => {
      lastErrorCode = (e as Event & { error?: string }).error ?? "unknown";
      console.warn("speech recognition error", lastErrorCode);
    });
    // Track natural end so stopRecording() can resolve immediately
    recognition.onend = () => {
      recognitionEnded = true;
      onEnd?.(lastErrorCode);
    };
    // Request getUserMedia first so macOS adds Chrome to System Settings →
    // Privacy & Security → Microphone (Web Speech API alone doesn't trigger it).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      recognition = null;
      return Promise.reject(new Error(`Microphone access denied: ${String(err)}`));
    }
    recognition.start();
    return;
  }
  return Promise.reject(new Error("SpeechRecognition not supported"));
}

export function resetTranscript(): void {
  lastTranscript = "";
}

export async function stopRecording(): Promise<string> {
  if (!recognition) {
    return "";
  }
  // Recognition already ended naturally — resolve immediately
  if (recognitionEnded) {
    const t = lastTranscript;
    lastTranscript = "";
    recognitionEnded = false;
    recognition = null;
    return t;
  }
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      const t = lastTranscript;
      lastTranscript = "";
      recognitionEnded = false;
      recognition = null;
      resolve(t);
    };
    recognition!.onend = finish;
    recognition!.stop();
    // Safety timeout — resolve even if onend never fires
    setTimeout(finish, 3000);
  });
}

// Warm up speechSynthesis on first user interaction so later automated calls aren't blocked.
// Call this once from a click handler (e.g. the audio toggle button).
export function primeSpeechSynthesis(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }
  // Use a short silent-sounding utterance; empty strings are ignored by Chrome.
  const utter = new SpeechSynthesisUtterance(" ");
  utter.volume = 0;
  window.speechSynthesis.speak(utter);
}

/**
 * Play text via browser speechSynthesis.
 */
export function playTTS(text: string): void {
  if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }
  const utter = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utter);
}
