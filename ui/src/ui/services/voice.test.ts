import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import * as voice from "./voice.ts";

describe("voice service", () => {
  beforeEach(() => {
    // reset globals
    vi.resetAllMocks();
  });

  it("startRecording rejects when SpeechRecognition unavailable", async () => {
    const win = window as unknown as Record<string, unknown>;
    const origRec = win.SpeechRecognition;
    delete win.SpeechRecognition;
    delete win.webkitSpeechRecognition;
    await expect(voice.startRecording()).rejects.toThrow("SpeechRecognition not supported");
    win.SpeechRecognition = origRec;
  });

  it("playTTS uses server when available and falls back", async () => {
    const requestMock = vi.fn().mockResolvedValue({ audioPath: "/fake.mp3" });
    const client = { request: requestMock } as unknown as GatewayBrowserClient;
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValueOnce();
    await voice.playTTS("hello world", client);
    expect(requestMock).toHaveBeenCalledWith("tts.convert", { text: "hello world" });
    expect(playSpy).toHaveBeenCalled();
    playSpy.mockRestore();
  });

  it("playTTS falls back to speechSynthesis when server fails", async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error("fail")) as GatewayBrowserClient["request"],
    } as unknown as GatewayBrowserClient;
    const speakSpy = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => {});
    await voice.playTTS("foo", client);
    expect(speakSpy).toHaveBeenCalled();
    speakSpy.mockRestore();
  });
});
