import { extractText } from "./chat/message-extract.ts";
import type { UiSettings } from "./storage.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

export type ResponseCompletionCueOptions = {
  message?: unknown;
  assistantName?: string | null;
  runId?: string | null;
  streamText?: string | null;
  visibleOutput?: boolean;
};

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const DUPLICATE_CUE_WINDOW_MS = 2_000;
let lastCue: { key: string; at: number } | null = null;

export function isSilentAssistantCompletion(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (normalizeLowercaseStringOrEmpty(entry.role) !== "assistant") {
    return false;
  }
  if (typeof entry.text === "string") {
    return SILENT_REPLY_PATTERN.test(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && SILENT_REPLY_PATTERN.test(text);
}

export function shouldSignalResponseCompletion(
  settings: Pick<UiSettings, "responseCompletionSound" | "responseCompletionOnlyWhenHidden">,
  opts: ResponseCompletionCueOptions = {},
): boolean {
  if (!settings.responseCompletionSound) {
    return false;
  }
  if (opts.visibleOutput === false) {
    return false;
  }
  if (opts.message && isSilentAssistantCompletion(opts.message)) {
    return false;
  }
  if (typeof opts.streamText === "string" && SILENT_REPLY_PATTERN.test(opts.streamText)) {
    return false;
  }
  if (settings.responseCompletionOnlyWhenHidden && isDocumentVisible()) {
    return false;
  }
  return true;
}

export function signalResponseCompletion(
  settings: Pick<
    UiSettings,
    "responseCompletionSound" | "responseCompletionOnlyWhenHidden" | "responseCompletionVolume"
  >,
  opts: ResponseCompletionCueOptions = {},
): void {
  if (!shouldSignalResponseCompletion(settings, opts)) {
    return;
  }
  if (isDuplicateCue(opts)) {
    return;
  }
  playResponseCompletionSound(settings.responseCompletionVolume);
}

export function resetResponseCompletionCueDedupeForTests(): void {
  lastCue = null;
}

function isDuplicateCue(opts: ResponseCompletionCueOptions): boolean {
  const key = cueDedupeKey(opts);
  if (!key) {
    return false;
  }
  const now = Date.now();
  if (lastCue && lastCue.key === key && now - lastCue.at < DUPLICATE_CUE_WINDOW_MS) {
    return true;
  }
  lastCue = { key, at: now };
  return false;
}

function cueDedupeKey(opts: ResponseCompletionCueOptions): string | null {
  const runId = opts.runId?.trim();
  if (runId) {
    return `run:${runId}`;
  }
  const text = completionTextForDedupe(opts).replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return `text:${text.slice(0, 240)}`;
}

function completionTextForDedupe(opts: ResponseCompletionCueOptions): string {
  if (typeof opts.streamText === "string" && opts.streamText.trim()) {
    return opts.streamText;
  }
  if (opts.message) {
    const text = extractText(opts.message);
    return typeof text === "string" ? text : "";
  }
  return "";
}

function isDocumentVisible(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  const visibilityState = String(document.visibilityState);
  if (visibilityState === "hidden") {
    return false;
  }
  if (typeof document.hasFocus === "function") {
    return document.hasFocus();
  }
  return visibilityState !== "hidden";
}

function normalizeVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.75;
  }
  return Math.min(1, Math.max(0, value / 100));
}

function playResponseCompletionSound(volumePercent?: number): void {
  const AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }
  try {
    const context = new AudioContextCtor();
    const play = () => {
      const now = context.currentTime;
      const gain = context.createGain();
      const peakVolume = Math.max(0.0001, 0.16 * normalizeVolume(volumePercent));
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peakVolume, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      gain.connect(context.destination);

      const first = context.createOscillator();
      first.type = "sine";
      first.frequency.setValueAtTime(660, now);
      first.connect(gain);
      first.start(now);
      first.stop(now + 0.12);

      const second = context.createOscillator();
      second.type = "sine";
      second.frequency.setValueAtTime(880, now + 0.08);
      second.connect(gain);
      second.start(now + 0.08);
      second.stop(now + 0.22);

      window.setTimeout(() => {
        void context.close().catch(() => undefined);
      }, 350);
    };

    if (context.state === "suspended") {
      void context.resume().then(play, play);
      return;
    }
    play();
  } catch {
    // Best-effort cue only; never break chat finalization.
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }

  // Some browsers still expose only webkitAudioContext on globalThis.
  // eslint-disable-next-line no-var
  var webkitAudioContext: typeof AudioContext | undefined;
}
