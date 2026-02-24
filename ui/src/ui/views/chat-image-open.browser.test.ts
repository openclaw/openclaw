import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, registerAppMountHooks } from "../test-helpers/app-mount.ts";

registerAppMountHooks();

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAssistantImage(url: string) {
  return {
    role: "assistant",
    content: [{ type: "image_url", image_url: { url } }],
    timestamp: Date.now(),
  };
}

describe("chat image open safety", () => {
  it("opens safe image URLs in a hardened new tab", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    app.chatMessages = [renderAssistantImage("https://example.com/cat.png")];
    await app.updateComplete;

    const image = app.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).not.toBeNull();
    image?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/cat.png",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not open unsafe image URLs", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    app.chatMessages = [renderAssistantImage("javascript:alert(1)")];
    await app.updateComplete;

    const image = app.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).not.toBeNull();
    image?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(openSpy).not.toHaveBeenCalled();
  });
});
