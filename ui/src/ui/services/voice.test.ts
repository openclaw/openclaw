import { describe, it, expect, vi, beforeEach } from "vitest";
import * as voice from "./voice.ts";

describe("voice service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("startRecording rejects when SpeechRecognition unavailable", async () => {
    // Stub window without SpeechRecognition to simulate unsupported browser
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { mediaDevices: undefined, language: "en-US" });
    await expect(voice.startRecording()).rejects.toThrow("SpeechRecognition not supported");
    vi.unstubAllGlobals();
  });

  it("startRecording rejects and clears recognition when getUserMedia is denied", async () => {
    const stopMock = vi.fn();
    const SpeechRecMock = vi.fn(() => ({
      continuous: false,
      interimResults: false,
      onend: null,
      start: vi.fn(),
      stop: stopMock,
      addEventListener: vi.fn(),
    }));
    vi.stubGlobal("SpeechRecognition", SpeechRecMock);
    vi.stubGlobal("navigator", {
      language: "en-US",
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
      },
    });
    await expect(voice.startRecording()).rejects.toThrow("Microphone access denied");
    // stopRecording should return empty string — recognition was cleared on denial
    await expect(voice.stopRecording()).resolves.toBe("");
    // stop() must NOT be called on the never-started recognition instance
    expect(stopMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("stopTTS cancels speechSynthesis", () => {
    const cancelSpy = vi.fn();
    vi.stubGlobal("window", { speechSynthesis: { cancel: cancelSpy } });
    voice.stopTTS();
    expect(cancelSpy).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("playTTS speaks via speechSynthesis", () => {
    const speakSpy = vi.fn();
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        constructor(t: string) {
          this.text = t;
        }
      },
    );
    vi.stubGlobal("window", { speechSynthesis: { speak: speakSpy } });
    voice.playTTS("hello world");
    expect(speakSpy).toHaveBeenCalledWith(expect.objectContaining({ text: "hello world" }));
    vi.unstubAllGlobals();
  });

  it("playTTS does nothing when text is empty", () => {
    const speakSpy = vi.fn();
    vi.stubGlobal("window", { speechSynthesis: { speak: speakSpy } });
    voice.playTTS("");
    expect(speakSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
