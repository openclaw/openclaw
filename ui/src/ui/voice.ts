import type { Locale } from "./i18n";

export type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  item: (index: number) => { transcript: string };
  [index: number]: { transcript: string };
};

export type SpeechRecognitionEventLike = {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
};

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const anyWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return anyWindow.SpeechRecognition ?? anyWindow.webkitSpeechRecognition ?? null;
}

export function supportsSpeechRecognition(): boolean {
  return Boolean(getSpeechRecognitionConstructor());
}

export function resolveSpeechLanguage(locale: Locale): string {
  return locale === "ar" ? "ar-SA" : "en-US";
}
