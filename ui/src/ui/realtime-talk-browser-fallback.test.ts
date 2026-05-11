/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserFallbackRealtimeTalkTransport,
  BrowserSpeechRealtimeTalkTransport,
  shouldUseBrowserFallbackForRealtimeError,
  shouldUseLocalTalkForRealtimeError,
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

describe("BrowserSpeechRealtimeTalkTransport", () => {
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

  it("uses deluxe chat plus Talk speech as the browser speech Talk engine", async () => {
    const listeners: GatewayListener[] = [];
    const request = vi.fn(async (method: string) => {
      if (method === "talk.config") {
        return { config: { talk: { speechLocale: "nl-NL" } } };
      }
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
    const transport = new BrowserSpeechRealtimeTalkTransport({
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
      expect.objectContaining({
        sessionKey: "main",
        message: "what is next",
        thinking: "off",
        timeoutMs: 30_000,
        conversationEngine: "deluxe-thomas",
      }),
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
    expect(
      onStatus.mock.calls.every(
        ([, detail]) => typeof detail !== "string" || !/fallback|browser dictation/i.test(detail),
      ),
    ).toBe(true);
  });

  it("keeps the old transport export as a compatibility alias", () => {
    expect(BrowserFallbackRealtimeTalkTransport).toBe(BrowserSpeechRealtimeTalkTransport);
  });

  it("uses the gateway Talk speech locale for local browser speech", async () => {
    Object.defineProperty(navigator, "language", {
      value: "en-US",
      configurable: true,
    });
    const request = vi.fn(async (method: string) => {
      if (method === "talk.config") {
        return { config: { talk: { speechLocale: "nl-NL" } } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const transport = new BrowserSpeechRealtimeTalkTransport({
      client: { request, addEventListener: vi.fn(() => () => undefined) } as never,
      sessionKey: "main",
      callbacks: {},
    });

    await transport.start();
    transport.stop();

    expect(request).toHaveBeenCalledWith("talk.config", {});
    expect(FakeRecognition.instances[0]?.lang).toBe("nl-NL");
  });

  it("recognizes provider setup failures as local Talk recovery candidates", () => {
    expect(
      shouldUseLocalTalkForRealtimeError(
        new Error('Realtime voice provider "openai" is not configured'),
      ),
    ).toBe(true);
    expect(
      shouldUseLocalTalkForRealtimeError(
        new Error("OpenAI realtime failed with insufficient_quota"),
      ),
    ).toBe(true);
    expect(
      shouldUseLocalTalkForRealtimeError(
        new Error("payment required: please add credits to continue"),
      ),
    ).toBe(true);
    expect(shouldUseLocalTalkForRealtimeError(new Error("401 unauthorized realtime request"))).toBe(
      true,
    );
    expect(shouldUseLocalTalkForRealtimeError(new Error("permission denied"))).toBe(false);
    expect(shouldUseBrowserFallbackForRealtimeError(new Error("429 rate limit"))).toBe(true);
  });
});
