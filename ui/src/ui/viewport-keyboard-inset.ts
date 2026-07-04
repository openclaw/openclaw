// Control UI module tracks the visible viewport hidden by mobile keyboards.

export const KEYBOARD_INSET_BOTTOM_VAR = "--keyboard-inset-bottom";

type KeyboardInsetViewport = {
  height: number;
  offsetTop: number;
};

export function computeKeyboardInsetBottom(params: {
  layoutViewportHeight: number;
  visualViewport: KeyboardInsetViewport | null | undefined;
}): number {
  const { layoutViewportHeight, visualViewport } = params;
  if (!visualViewport || !Number.isFinite(layoutViewportHeight)) {
    return 0;
  }
  const bottomInset = layoutViewportHeight - visualViewport.offsetTop - visualViewport.height;
  if (!Number.isFinite(bottomInset) || bottomInset <= 0) {
    return 0;
  }
  return Math.round(bottomInset);
}

export function installViewportKeyboardInset() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const root = document.documentElement;
  let frame: number | null = null;

  const update = () => {
    frame = null;
    const inset = computeKeyboardInsetBottom({
      layoutViewportHeight: window.innerHeight,
      visualViewport: window.visualViewport,
    });
    root.style.setProperty(KEYBOARD_INSET_BOTTOM_VAR, `${inset}px`);
  };

  const scheduleUpdate = () => {
    if (frame !== null) {
      return;
    }
    frame = window.requestAnimationFrame(update);
  };

  update();
  window.visualViewport?.addEventListener("resize", scheduleUpdate);
  window.visualViewport?.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("orientationchange", scheduleUpdate);

  return () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    window.visualViewport?.removeEventListener("resize", scheduleUpdate);
    window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("orientationchange", scheduleUpdate);
    root.style.removeProperty(KEYBOARD_INSET_BOTTOM_VAR);
  };
}
