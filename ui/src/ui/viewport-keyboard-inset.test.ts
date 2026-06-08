// Control UI tests cover mobile keyboard inset detection.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeKeyboardInsetBottom,
  installViewportKeyboardInset,
  KEYBOARD_INSET_BOTTOM_VAR,
} from "./viewport-keyboard-inset.ts";

function createMockVisualViewport(params: { height: number; offsetTop: number }) {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    height: params.height,
    offsetTop: params.offsetTop,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const current = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        if (typeof listener === "function") {
          listener(new Event(type));
        } else {
          listener.handleEvent(new Event(type));
        }
      }
    },
  };
}

async function waitForAnimationFrame() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(KEYBOARD_INSET_BOTTOM_VAR);
});

describe("computeKeyboardInsetBottom", () => {
  it("returns the viewport area hidden below the visual viewport", () => {
    expect(
      computeKeyboardInsetBottom({
        layoutViewportHeight: 844,
        visualViewport: { height: 520.4, offsetTop: 0 },
      }),
    ).toBe(324);
  });

  it("accounts for shifted visual viewports", () => {
    expect(
      computeKeyboardInsetBottom({
        layoutViewportHeight: 844,
        visualViewport: { height: 500, offsetTop: 44 },
      }),
    ).toBe(300);
  });

  it("returns zero when the visual viewport already fits the layout viewport", () => {
    expect(
      computeKeyboardInsetBottom({
        layoutViewportHeight: 844,
        visualViewport: { height: 844, offsetTop: 0 },
      }),
    ).toBe(0);
  });

  it("syncs the keyboard inset CSS variable from visual viewport changes", async () => {
    const visualViewport = createMockVisualViewport({ height: 844, offsetTop: 0 });
    vi.stubGlobal("innerHeight", 844);
    vi.stubGlobal("visualViewport", visualViewport);

    const cleanup = installViewportKeyboardInset();
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_BOTTOM_VAR)).toBe("0px");

    visualViewport.height = 520;
    visualViewport.dispatch("resize");
    await waitForAnimationFrame();

    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_BOTTOM_VAR)).toBe(
      "324px",
    );
    cleanup();
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_BOTTOM_VAR)).toBe("");
  });
});
