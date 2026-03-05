import { describe, expect, it, vi } from "vitest";
import {
  attachVisualViewportKeyboardInset,
  CHAT_KEYBOARD_INSET_CSS_VAR,
  computeVisualViewportKeyboardInset,
} from "./visual-viewport.ts";

function createListenerStore() {
  return new Map<string, Set<() => void>>();
}

function fireListener(store: Map<string, Set<() => void>>, type: string) {
  for (const listener of store.get(type) ?? []) {
    listener();
  }
}

describe("computeVisualViewportKeyboardInset", () => {
  it("ignores small visual viewport changes from browser chrome", () => {
    expect(
      computeVisualViewportKeyboardInset({
        windowInnerHeight: 844,
        viewportHeight: 800,
        viewportOffsetTop: 0,
      }),
    ).toBe(0);
  });

  it("returns the keyboard overlap when the visual viewport shrinks substantially", () => {
    expect(
      computeVisualViewportKeyboardInset({
        windowInnerHeight: 844,
        viewportHeight: 512,
        viewportOffsetTop: 0,
      }),
    ).toBe(332);
  });

  it("accounts for shifted visual viewports on iOS", () => {
    expect(
      computeVisualViewportKeyboardInset({
        windowInnerHeight: 844,
        viewportHeight: 512,
        viewportOffsetTop: 24,
      }),
    ).toBe(308);
  });
});

describe("attachVisualViewportKeyboardInset", () => {
  it("updates and clears the chat keyboard inset CSS variable", () => {
    const root = document.createElement("div");
    const viewportListeners = createListenerStore();
    const windowListeners = createListenerStore();
    const viewport = {
      height: 844,
      offsetTop: 0,
      addEventListener: vi.fn((type: "resize" | "scroll", listener: () => void) => {
        const set = viewportListeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        viewportListeners.set(type, set);
      }),
      removeEventListener: vi.fn((type: "resize" | "scroll", listener: () => void) => {
        viewportListeners.get(type)?.delete(listener);
      }),
    };
    const win = {
      innerHeight: 844,
      visualViewport: viewport,
      addEventListener: vi.fn((type: "resize", listener: () => void) => {
        const set = windowListeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        windowListeners.set(type, set);
      }),
      removeEventListener: vi.fn((type: "resize", listener: () => void) => {
        windowListeners.get(type)?.delete(listener);
      }),
    };

    const cleanup = attachVisualViewportKeyboardInset({ root, win });

    expect(root.style.getPropertyValue(CHAT_KEYBOARD_INSET_CSS_VAR)).toBe("0px");

    viewport.height = 500;
    fireListener(viewportListeners, "resize");
    expect(root.style.getPropertyValue(CHAT_KEYBOARD_INSET_CSS_VAR)).toBe("344px");

    cleanup();

    expect(root.style.getPropertyValue(CHAT_KEYBOARD_INSET_CSS_VAR)).toBe("");
    expect(viewport.removeEventListener).toHaveBeenCalledTimes(2);
    expect(win.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("defaults the CSS variable to document.documentElement", () => {
    const viewportListeners = createListenerStore();
    const viewport = {
      height: 844,
      offsetTop: 0,
      addEventListener: vi.fn((type: "resize" | "scroll", listener: () => void) => {
        const set = viewportListeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        viewportListeners.set(type, set);
      }),
      removeEventListener: vi.fn((type: "resize" | "scroll", listener: () => void) => {
        viewportListeners.get(type)?.delete(listener);
      }),
    };
    const win = {
      innerHeight: 844,
      visualViewport: viewport,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const cleanup = attachVisualViewportKeyboardInset({ win });

    viewport.height = 500;
    fireListener(viewportListeners, "resize");
    expect(document.documentElement.style.getPropertyValue(CHAT_KEYBOARD_INSET_CSS_VAR)).toBe(
      "344px",
    );

    cleanup();
  });
});
