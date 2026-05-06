// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSilentAssistantCompletion,
  shouldSignalResponseCompletion,
  signalResponseCompletion,
} from "./response-completion-cue.ts";

describe("response completion cue", () => {
  afterEach(() => {
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
