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
