/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserFallbackRealtimeTalkTransport,
  shouldUseBrowserFallbackForRealtimeError,
} from "./chat/realtime-talk-browser-fallback.ts";

type GatewayListener = (event: { event: string; payload?: unknown }) => void;

class FakeRecognition {
  static instances: FakeRecognition[] = [];

  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string; message?: string }) => void) | null = null;
  onresult:
    | ((event: {
        resultIndex: number;
        results: { length: number; 0: { isFinal: boolean; 0: { transcript: string } } };
      }) => void)
    | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start() {
    this.onstart?.();
  }

  stop() {
    this.onend?.();
  }

  abort() {}

  emitFinalTranscript(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          isFinal: true,
          0: { transcript: text },
        },
      },
    });
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];

  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => {
    queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  });
  pause = vi.fn();

  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("BrowserFallbackRealtimeTalkTransport", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    FakeAudio.instances = [];
    Object.defineProperty(window, "SpeechRecognition", {
      value: FakeRecognition,
      configurable: true,
    });
    Object.defineProperty(globalThis, "Audio", {
      value: FakeAudio,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses normal chat plus Talk speech when realtime auth is unavailable", async () => {
    const listeners: GatewayListener[] = [];
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { runId: "run-1" };
      }
      if (method === "talk.speak") {
        return { audioBase64: "UklGRg==", mimeType: "audio/mpeg" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const addEventListener = vi.fn((listener: GatewayListener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    });
    const onStatus = vi.fn();
    const onTranscript = vi.fn();
    const transport = new BrowserFallbackRealtimeTalkTransport({
      client: { request, addEventListener } as never,
      sessionKey: "main",
      callbacks: { onStatus, onTranscript },
    });

    await transport.start();
    FakeRecognition.instances[0]?.emitFinalTranscript("what is next");
    await flushMicrotasks();
    listeners[0]?.({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "final",
        message: { text: "Here is the answer." },
      },
    });
    await flushMicrotasks();
    transport.stop();

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ sessionKey: "main", message: "what is next" }),
    );
    expect(request).toHaveBeenCalledWith("talk.speak", { text: "Here is the answer." });
    expect(onTranscript).toHaveBeenCalledWith({
      role: "user",
      text: "what is next",
      final: true,
    });
    expect(onTranscript).toHaveBeenCalledWith({
      role: "assistant",
      text: "Here is the answer.",
      final: true,
    });
    expect(FakeAudio.instances[0]?.src).toBe("data:audio/mpeg;base64,UklGRg==");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Asking Thomas...");
  });

  it("recognizes provider setup failures as fallback candidates", () => {
    expect(
      shouldUseBrowserFallbackForRealtimeError(
        new Error('Realtime voice provider "openai" is not configured'),
      ),
    ).toBe(true);
    expect(shouldUseBrowserFallbackForRealtimeError(new Error("permission denied"))).toBe(false);
  });
});
