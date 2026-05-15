// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSilentAssistantCompletion,
  resetResponseCompletionCueDedupeForTests,
  shouldSignalResponseCompletion,
  signalResponseCompletion,
} from "./response-completion-cue.ts";

describe("response completion cue", () => {
  afterEach(() => {
    resetResponseCompletionCueDedupeForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stays disabled until a completion cue is enabled", () => {
    expect(shouldSignalResponseCompletion({})).toBe(false);
  });

  it("skips silent assistant completions", () => {
    expect(
      isSilentAssistantCompletion({
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
      }),
    ).toBe(true);
    expect(
      shouldSignalResponseCompletion(
        { responseCompletionSound: true },
        { message: { role: "assistant", text: "NO_REPLY" } },
      ),
    ).toBe(false);
  });

  it("skips finals without visible output", () => {
    expect(
      shouldSignalResponseCompletion(
        { responseCompletionSound: true, responseCompletionOnlyWhenHidden: false },
        { visibleOutput: false },
      ),
    ).toBe(false);
  });

  it("skips silent stream-only finals", () => {
    expect(
      shouldSignalResponseCompletion(
        { responseCompletionSound: true, responseCompletionOnlyWhenHidden: false },
        { streamText: "NO_REPLY", visibleOutput: true },
      ),
    ).toBe(false);
  });

  it("honors the hidden-only preference", () => {
    vi.stubGlobal("document", {
      visibilityState: "visible",
      hasFocus: () => true,
    });

    expect(
      shouldSignalResponseCompletion({
        responseCompletionSound: true,
        responseCompletionOnlyWhenHidden: true,
      }),
    ).toBe(false);
  });

  it("allows cues when the document is hidden", () => {
    vi.stubGlobal("document", {
      visibilityState: "hidden",
      hasFocus: () => false,
    });

    expect(
      shouldSignalResponseCompletion({
        responseCompletionSound: true,
        responseCompletionOnlyWhenHidden: true,
      }),
    ).toBe(true);
  });

  it("deduplicates repeated cues for the same run", () => {
    const playCount = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.stubGlobal("AudioContext", class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain() {
        return {
          gain: {
            setValueAtTime() {},
            exponentialRampToValueAtTime() {},
          },
          connect() {},
        };
      }
      createOscillator() {
        return {
          type: "sine",
          frequency: { setValueAtTime() {} },
          connect() {},
          start: playCount,
          stop() {},
        };
      }
      close() {
        return Promise.resolve();
      }
    });
    vi.stubGlobal("window", { setTimeout: vi.fn() });

    signalResponseCompletion(
      { responseCompletionSound: true, responseCompletionOnlyWhenHidden: false },
      { runId: "run-1", visibleOutput: true, streamText: "Done" },
    );
    signalResponseCompletion(
      { responseCompletionSound: true, responseCompletionOnlyWhenHidden: false },
      { runId: "run-1", visibleOutput: true, streamText: "Done" },
    );

    expect(playCount).toHaveBeenCalledTimes(2);
  });

  it("does not use browser notifications for response completion cues", () => {
    const notification = vi.fn();
    vi.stubGlobal("Notification", Object.assign(notification, { permission: "granted" }));

    signalResponseCompletion(
      { responseCompletionSound: true, responseCompletionOnlyWhenHidden: false },
      { assistantName: "Goat" },
    );

    expect(notification).not.toHaveBeenCalled();
  });
});
