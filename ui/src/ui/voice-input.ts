/**
 * Voice input utility using Web Speech API.
 * Provides feature detection, speech recognition, and transcription.
 */

// Web Speech API types (not available in TypeScript by default)
interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

/**
 * Check if Web Speech API is supported in the browser.
 */
export function isVoiceInputSupported(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      (window.SpeechRecognition || window.webkitSpeechRecognition),
  );
}

/**
 * Get the SpeechRecognition constructor if available.
 */
function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export type VoiceInputState = {
  isRecording: boolean;
  transcript: string;
  interimTranscript: string;
  error: string | null;
};

export type VoiceInputCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (error: string) => void;
  onStart: () => void;
  onEnd: () => void;
};

let activeRecognition: SpeechRecognition | null = null;

/**
 * Start voice recognition and call back with transcriptions.
 * Returns a stop function, or null if not supported.
 */
export function startVoiceRecognition(
  callbacks: VoiceInputCallbacks,
): (() => void) | null {
  const SpeechRecognitionClass = getSpeechRecognition();
  if (!SpeechRecognitionClass) {
    callbacks.onError("Voice input not supported in this browser");
    return null;
  }

  // Stop any existing recognition
  if (activeRecognition) {
    activeRecognition.abort();
    activeRecognition = null;
  }

  const recognition = new SpeechRecognitionClass();
  activeRecognition = recognition;

  // Configure recognition
  recognition.continuous = false; // Single utterance mode for mobile
  recognition.interimResults = true; // Show partial results
  recognition.lang = navigator.language || "en-US";

  recognition.onstart = () => {
    callbacks.onStart();
  };

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    let finalTranscript = "";
    let interimTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result[0]) {
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }
    }

    if (finalTranscript) {
      callbacks.onTranscript(finalTranscript, true);
    } else if (interimTranscript) {
      callbacks.onTranscript(interimTranscript, false);
    }
  };

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    let errorMessage = "Voice recognition error";
    switch (event.error) {
      case "no-speech":
        errorMessage = "No speech detected. Try again.";
        break;
      case "audio-capture":
        errorMessage = "Microphone not available";
        break;
      case "not-allowed":
        errorMessage = "Microphone access denied";
        break;
      case "network":
        errorMessage = "Network error during recognition";
        break;
      case "aborted":
        // User cancelled, not an error
        return;
      default:
        errorMessage = `Recognition error: ${event.error}`;
    }
    callbacks.onError(errorMessage);
  };

  recognition.onend = () => {
    if (activeRecognition === recognition) {
      activeRecognition = null;
    }
    callbacks.onEnd();
  };

  try {
    recognition.start();
  } catch {
    callbacks.onError("Failed to start voice recognition");
    return null;
  }

  // Return stop function
  return () => {
    if (activeRecognition === recognition) {
      recognition.stop();
      activeRecognition = null;
    }
  };
}

/**
 * Stop any active voice recognition.
 */
export function stopVoiceRecognition(): void {
  if (activeRecognition) {
    activeRecognition.stop();
    activeRecognition = null;
  }
}
