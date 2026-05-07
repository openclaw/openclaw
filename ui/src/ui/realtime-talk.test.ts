// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  googleStart,
  googleStop,
  relayStart,
  relayStop,
  webRtcStart,
  webRtcStop,
  localStart,
  localStop,
  googleCtor,
  relayCtor,
  webRtcCtor,
  localCtor,
} = vi.hoisted(() => ({
  googleStart: vi.fn(async () => undefined),
  googleStop: vi.fn(),
  relayStart: vi.fn(async () => undefined),
  relayStop: vi.fn(),
  webRtcStart: vi.fn(async () => undefined),
  webRtcStop: vi.fn(),
  localStart: vi.fn(async () => undefined),
  localStop: vi.fn(),
  googleCtor: vi.fn(function () {
    return { start: googleStart, stop: googleStop };
  }),
  relayCtor: vi.fn(function () {
    return { start: relayStart, stop: relayStop };
  }),
  webRtcCtor: vi.fn(function () {
    return { start: webRtcStart, stop: webRtcStop };
  }),
  localCtor: vi.fn(function () {
    return { start: localStart, stop: localStop };
  }),
}));

vi.mock("./chat/realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: googleCtor,
}));

vi.mock("./chat/realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: relayCtor,
}));

vi.mock("./chat/realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: webRtcCtor,
}));

vi.mock("./chat/realtime-talk-browser-fallback.ts", () => ({
  BrowserFallbackRealtimeTalkTransport: localCtor,
  BrowserSpeechRealtimeTalkTransport: localCtor,
  shouldUseBrowserFallbackForRealtimeError: (error: unknown) =>
    error instanceof Error && /not configured|quota|billing|credit|429/i.test(error.message),
  shouldUseLocalTalkForRealtimeError: (error: unknown) =>
    error instanceof Error && /not configured|quota|billing|credit|429/i.test(error.message),
}));

import { RealtimeTalkSession } from "./chat/realtime-talk.ts";

describe("RealtimeTalkSession", () => {
  beforeEach(() => {
    googleStart.mockClear();
    googleStop.mockClear();
    relayStart.mockClear();
    relayStop.mockClear();
    webRtcStart.mockClear();
    webRtcStop.mockClear();
    localStart.mockClear();
    localStop.mockClear();
    googleCtor.mockClear();
    relayCtor.mockClear();
    webRtcCtor.mockClear();
    localCtor.mockClear();
  });

  it("starts the Google Live WebSocket transport from a generic session result", async () => {
    const request = vi.fn(async () => ({
      provider: "google",
      transport: "provider-websocket",
      protocol: "google-live-bidi",
      clientSecret: "auth_tokens/session",
      websocketUrl: "wss://example.test/live",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 16000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const onStatus = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "main", { onStatus });

    await session.start();

    expect(request).toHaveBeenCalledWith("talk.client.create", { sessionKey: "main" });
    expect(googleCtor).toHaveBeenCalledTimes(1);
    expect(googleStart).toHaveBeenCalledTimes(1);
    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("connecting");
  });

  it("defaults legacy session results without an explicit transport to WebRTC", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      clientSecret: "auth_tokens/session",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
  });

  it("accepts legacy WebRTC transport names", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc-sdp",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
  });

  it("accepts legacy provider WebSocket transport names", async () => {
    const request = vi.fn(async () => ({
      provider: "example",
      transport: "json-pcm-websocket",
      clientSecret: "secret",
      protocol: "google-live-bidi",
      websocketUrl: "wss://example.test/live",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 16000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(googleCtor).toHaveBeenCalledTimes(1);
  });

  it("starts the Gateway relay transport for backend-only realtime providers", async () => {
    const request = vi.fn(async () => ({
      provider: "example",
      transport: "gateway-relay",
      relaySessionId: "relay-1",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(relayCtor).toHaveBeenCalledTimes(1);
    expect(relayStart).toHaveBeenCalledTimes(1);
    expect(relayStop).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
    expect(webRtcCtor).not.toHaveBeenCalled();
  });

  it("starts the WebRTC transport for canonical WebRTC sessions", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    expect(webRtcStop).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
  });

  it("passes launch options to client-owned realtime session creation", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      {
        provider: "openai",
        model: "gpt-realtime-2",
        voice: "marin",
        transport: "webrtc",
        vadThreshold: 0.45,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
        reasoningEffort: "low",
      },
    );

    await session.start();

    expect(request).toHaveBeenCalledWith("talk.client.create", {
      sessionKey: "main",
      provider: "openai",
      model: "gpt-realtime-2",
      voice: "marin",
      transport: "webrtc",
      vadThreshold: 0.45,
      silenceDurationMs: 650,
      prefixPaddingMs: 250,
      reasoningEffort: "low",
    });
  });

  it("starts the local Talk engine when the gateway selects browser speech", async () => {
    const request = vi.fn(async () => ({
      provider: "local-voice",
      transport: "browser-speech-local",
      speechLocale: "nl-NL",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(request).toHaveBeenCalledWith("talk.client.create", { sessionKey: "main" });
    expect(localCtor).toHaveBeenCalledTimes(1);
    expect(localCtor).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "main" }),
      expect.objectContaining({
        session: expect.objectContaining({
          transport: "browser-speech-local",
          speechLocale: "nl-NL",
        }),
      }),
    );
    expect(localStart).toHaveBeenCalledTimes(1);
    expect(localStop).toHaveBeenCalledTimes(1);
    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(googleCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
  });

  it("switches to the local Talk engine when realtime is not configured", async () => {
    const request = vi.fn(async () => {
      throw new Error('Realtime voice provider "openai" is not configured');
    });
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(localCtor).toHaveBeenCalledTimes(1);
    expect(localStart).toHaveBeenCalledTimes(1);
    expect(localStop).toHaveBeenCalledTimes(1);
    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(googleCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
  });

  it("switches to the local Talk engine when WebRTC setup hits OpenAI quota", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc-sdp",
      clientSecret: "secret",
    }));
    webRtcStart.mockRejectedValueOnce(
      new Error("Realtime WebRTC setup failed (429): You exceeded your current quota"),
    );
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(webRtcStop).toHaveBeenCalledTimes(1);
    expect(localCtor).toHaveBeenCalledTimes(1);
    expect(localStart).toHaveBeenCalledTimes(1);
    expect(localStop).toHaveBeenCalledTimes(1);
  });

  it("switches to local Talk when an active WebRTC transport reports OpenAI quota", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc-sdp",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    const transport = webRtcCtor.mock.results[0]?.value as never;
    const ctx = webRtcCtor.mock.calls[0]?.[1] as
      | { onRecoverableError?: (error: Error, source: never) => boolean }
      | undefined;

    expect(ctx?.onRecoverableError?.(new Error("You exceeded your current quota"), transport)).toBe(
      true,
    );
    await vi.waitFor(() => expect(localStart).toHaveBeenCalledTimes(1));
    expect(webRtcStop).toHaveBeenCalledTimes(1);

    session.stop();
    expect(localStop).toHaveBeenCalledTimes(1);
  });

  it("does not mask unrelated realtime startup failures", async () => {
    const request = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const session = new RealtimeTalkSession({ request } as never, "main");

    await expect(session.start()).rejects.toThrow("permission denied");

    expect(localCtor).not.toHaveBeenCalled();
  });
});
