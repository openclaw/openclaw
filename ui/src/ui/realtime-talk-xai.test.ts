// Control UI tests cover xAI realtime Talk behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "./chat/realtime-talk-shared.ts";
import type {
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkTransportContext,
} from "./chat/realtime-talk-shared.ts";
import { buildXaiRealtimeUrl, XaiRealtimeTalkTransport } from "./chat/realtime-talk-xai.ts";
import type { GatewayEventFrame } from "./gateway.ts";

type MockWebSocketEvent = {
  data?: unknown;
};

type MockWebSocketHandler = (event?: MockWebSocketEvent) => void;
type MockWebSocketEventType = "close" | "error" | "message" | "open";

const wsInstances: MockXaiRealtimeWebSocket[] = [];
const createdSources: MockAudioBufferSource[] = [];

class MockXaiRealtimeWebSocket {
  static OPEN = 1;

  readonly handlers: Record<MockWebSocketEventType, MockWebSocketHandler[]> = {
    close: [],
    error: [],
    message: [],
    open: [],
  };
  readonly sent: string[] = [];
  binaryType: BinaryType = "blob";
  readyState = MockXaiRealtimeWebSocket.OPEN;

  constructor(
    readonly url: string,
    readonly protocol?: string,
  ) {
    wsInstances.push(this);
  }

  addEventListener(type: MockWebSocketEventType, handler: MockWebSocketHandler) {
    this.handlers[type].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emitOpen() {
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: unknown) {
    for (const handler of this.handlers.message) {
      handler({ data });
    }
  }
}

class MockAudioBufferSource {
  buffer: unknown = null;
  readonly addEventListener = vi.fn();
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;
  readonly close = vi.fn(async () => undefined);

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24000;
  }

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createScriptProcessor() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channel,
    };
  }

  createBufferSource() {
    const source = new MockAudioBufferSource();
    createdSources.push(source);
    return source;
  }
}

function createSession(
  overrides: Partial<RealtimeTalkJsonPcmWebSocketSessionResult> = {},
): RealtimeTalkJsonPcmWebSocketSessionResult {
  return {
    provider: "xai",
    transport: "provider-websocket",
    protocol: "xai-realtime",
    clientSecret: "xai-ephemeral-token",
    websocketUrl: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
    initialMessage: {
      type: "session.update",
      session: {
        voice: "leo",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "grok-transcribe" },
          },
          output: { format: { type: "audio/pcm", rate: 24000 } },
        },
      },
    },
    ...overrides,
  };
}

function createClient(): RealtimeTalkTransportContext["client"] {
  return {
    addEventListener: vi.fn(() => () => undefined),
    request: vi.fn(),
  } as unknown as RealtimeTalkTransportContext["client"];
}

function createTransport(
  callbacks: RealtimeTalkTransportContext["callbacks"] = {},
  client = createClient(),
  session = createSession(),
) {
  return new XaiRealtimeTalkTransport(session, {
    callbacks,
    client,
    sessionKey: "main",
  });
}

function latestWebSocket(): MockXaiRealtimeWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing WebSocket");
  }
  return ws;
}

function encodeJsonFrame(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

describe("XaiRealtimeTalkTransport", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    createdSources.length = 0;
    vi.stubGlobal("WebSocket", MockXaiRealtimeWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens xAI with the documented browser client secret subprotocol", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onStatus, onTalkEvent });

    await transport.start();
    const ws = latestWebSocket();
    ws.emitOpen();
    ws.emitMessage(encodeJsonFrame({ type: "session.updated" }));

    expect(ws.url).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-latest");
    expect(ws.protocol).toBe("xai-client-secret.xai-ephemeral-token");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual(createSession().initialMessage);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    expect(onTalkEvent.mock.calls[0]?.[0]).toMatchObject({
      type: "session.ready",
      sessionId: "main:xai:provider-websocket",
      transport: "provider-websocket",
      provider: "xai",
    });
  });

  it("maps cumulative inbound speech updates and assistant audio to common Talk events", async () => {
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTranscript, onTalkEvent });

    await transport.start();
    const ws = latestWebSocket();
    ws.emitMessage(
      encodeJsonFrame({
        type: "conversation.item.input_audio_transcription.updated",
        transcript: "we need meeting transcription",
      }),
    );
    ws.emitMessage(
      encodeJsonFrame({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "we need meeting transcription",
      }),
    );
    ws.emitMessage(
      encodeJsonFrame({
        type: "response.output_audio.delta",
        delta: "AAAAAA==",
      }),
    );
    ws.emitMessage(
      encodeJsonFrame({
        type: "response.output_audio.done",
      }),
    );

    await vi.waitFor(() => expect(createdSources).toHaveLength(1));
    expect(onTranscript).toHaveBeenCalledWith({
      role: "user",
      text: "we need meeting transcription",
      final: false,
    });
    expect(onTranscript).toHaveBeenCalledWith({
      role: "user",
      text: "we need meeting transcription",
      final: true,
    });
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "transcript.delta",
      "transcript.done",
      "output.audio.started",
      "output.audio.delta",
      "output.audio.done",
    ]);
    expect(onTalkEvent.mock.calls[3]?.[0].payload).toStrictEqual({
      byteLength: 4,
      mimeType: "audio/pcm;rate=24000",
    });
  });

  it("routes xAI function calls through talk.client.toolCall", async () => {
    const listeners = new Set<(event: GatewayEventFrame) => void>();
    const client = createClient();
    vi.mocked(client["addEventListener"]).mockImplementation(
      (listener: (event: GatewayEventFrame) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    );
    vi.mocked(client["request"]).mockImplementation(async (method, params) => {
      expect(method).toBe("talk.client.toolCall");
      expect(params).toMatchObject({
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      });
      return { runId: "run-1" };
    });
    const transport = createTransport({}, client);

    await transport.start();
    const ws = latestWebSocket();
    ws.emitMessage(
      encodeJsonFrame({
        type: "response.function_call_arguments.done",
        item_id: "item-1",
        call_id: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        arguments: JSON.stringify({ question: "status" }),
      }),
    );

    await vi.waitFor(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
    );
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    for (const listener of listeners) {
      listener({
        type: "event",
        event: "chat",
        payload: { runId: "run-1", state: "final", message: { text: "done" } },
      });
    }
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(2));
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent.slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify({ result: "done" }),
        },
      },
      { type: "response.create" },
    ]);
  });

  it("rejects untrusted xAI realtime websocket URLs", () => {
    expect(() =>
      buildXaiRealtimeUrl({
        ...createSession(),
        websocketUrl: "wss://example.com/v1/realtime?model=grok-voice-latest",
      }),
    ).toThrow("Untrusted xAI Realtime WebSocket host");
  });
});
