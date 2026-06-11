const MIN_KEYBOARD_INSET_PX = 40;
const DEFAULT_CHAT_COMPOSER_HEIGHT_PX = 132;

export type MobileKeyboardInsetInput = {
  innerHeight: number;
  layoutHeight?: number;
  viewportHeight: number;
  viewportOffsetTop: number;
  textInputFocused: boolean;
  fallbackKeyboardInset?: number;
  composerBottom?: number;
  currentInset?: number;
  desiredGap?: number;
};

export type MobileViewportInsetHost = {
  style: CSSStyleDeclaration;
  mobileViewportCleanup?: (() => void) | null;
};

export type MobileComposerPaddingInput = {
  composerHeight?: number;
  keyboardInset?: number;
  safeAreaBottom?: number;
  gap?: number;
};

export function computeMobileComposerBottomPadding(input: MobileComposerPaddingInput): number {
  const composerHeight = Math.max(
    DEFAULT_CHAT_COMPOSER_HEIGHT_PX,
    Math.round(input.composerHeight ?? 0),
  );
  const keyboardInset = Math.max(0, Math.round(input.keyboardInset ?? 0));
  const safeAreaBottom = Math.max(0, Math.round(input.safeAreaBottom ?? 0));
  const gap = Math.max(0, Math.round(input.gap ?? 16));
  return composerHeight + keyboardInset + safeAreaBottom + gap;
}

export function computeMobileKeyboardInset(input: MobileKeyboardInsetInput): number {
  if (!input.textInputFocused) {
    return 0;
  }
  const layoutHeight = input.layoutHeight ?? input.innerHeight;
  const rawInset = layoutHeight - input.viewportHeight - input.viewportOffsetTop;
  const inset = Math.max(0, Math.round(rawInset));
  const fallbackInset = Math.max(0, Math.round(input.fallbackKeyboardInset ?? 0));
  const currentInset = Math.max(0, Math.round(input.currentInset ?? 0));
  const hasViewportKeyboardSignal = inset >= MIN_KEYBOARD_INSET_PX;
  if (hasViewportKeyboardSignal && typeof input.composerBottom === "number") {
    const visibleBottom = input.viewportOffsetTop + input.viewportHeight;
    const unshiftedComposerBottom = input.composerBottom + currentInset;
    const desiredGap = Math.max(0, Math.round(input.desiredGap ?? 8));
    return Math.max(0, Math.round(unshiftedComposerBottom - visibleBottom + desiredGap));
  }
  if (inset >= MIN_KEYBOARD_INSET_PX) {
    return inset;
  }
  return fallbackInset >= MIN_KEYBOARD_INSET_PX ? fallbackInset : 0;
}

function isTextInputElement(node: Element | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  if (node.isContentEditable) {
    return true;
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "textarea") {
    return true;
  }
  if (tag !== "input") {
    return false;
  }
  const input = node as HTMLInputElement;
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(input.type);
}

function activeTextInputIsInChatComposer(): boolean {
  const active = document.activeElement;
  if (!isTextInputElement(active)) {
    return false;
  }
  return active.closest(".content--chat .agent-chat__input") !== null;
}

function getLayoutViewportHeight(viewport: VisualViewport | null | undefined): number {
  return Math.max(
    window.innerHeight,
    document.documentElement?.clientHeight ?? 0,
    viewport?.height ?? 0,
  );
}

function isLikelyTouchPhoneViewport(): boolean {
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const hasTouch = (navigator.maxTouchPoints ?? 0) > 0;
  return (coarsePointer || hasTouch) && Math.min(window.innerWidth, window.innerHeight) <= 820;
}

function estimateKeyboardFallbackInset(layoutHeight: number): number {
  return Math.round(Math.min(430, Math.max(320, layoutHeight * 0.44)));
}

function readCurrentKeyboardInset(host: MobileViewportInsetHost): number {
  const hostValue = Number.parseFloat(host.style.getPropertyValue("--mobile-keyboard-inset"));
  if (Number.isFinite(hostValue)) {
    return hostValue;
  }
  const rootValue = Number.parseFloat(
    document.documentElement.style.getPropertyValue("--mobile-keyboard-inset"),
  );
  return Number.isFinite(rootValue) ? rootValue : 0;
}

function getChatComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".content--chat .agent-chat__input");
}

function getChatComposerBottom(): number | undefined {
  const composer = getChatComposer();
  if (!composer) {
    return undefined;
  }
  return composer.getBoundingClientRect().bottom;
}

function readCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSafeAreaBottom(): number {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--safe-area-bottom")
    .trim();
  return Math.max(0, readCssPixelValue(value));
}

function getChatComposerHeight(): number {
  const composer = getChatComposer();
  if (!composer) {
    return DEFAULT_CHAT_COMPOSER_HEIGHT_PX;
  }
  const height = Math.round(composer.getBoundingClientRect().height);
  return height > 0 ? height : DEFAULT_CHAT_COMPOSER_HEIGHT_PX;
}

export function installMobileViewportInsetObserver(host: MobileViewportInsetHost) {
  if (typeof window === "undefined") {
    return;
  }
  host.mobileViewportCleanup?.();
  const viewport = window.visualViewport;
  let frame: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let observedComposer: HTMLElement | null = null;
  let largestLayoutHeight = getLayoutViewportHeight(viewport);
  let focusedSince = 0;
  let schedule = () => {};

  const writeRootPixelVar = (name: string, pixels: number) => {
    const value = `${Math.max(0, Math.round(pixels))}px`;
    host.style.setProperty(name, value);
    document.documentElement.style.setProperty(name, value);
  };

  const refreshComposerObserver = () => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const composer = getChatComposer();
    if (composer === observedComposer) {
      return;
    }
    resizeObserver?.disconnect();
    observedComposer = composer;
    if (!composer) {
      resizeObserver = null;
      return;
    }
    resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(composer);
  };

  const applyInset = () => {
    frame = null;
    refreshComposerObserver();
    const textInputFocused = activeTextInputIsInChatComposer();
    const now = window.performance?.now?.() ?? Date.now();
    const currentLayoutHeight = getLayoutViewportHeight(viewport);
    if (!textInputFocused) {
      focusedSince = 0;
      largestLayoutHeight = Math.max(largestLayoutHeight, currentLayoutHeight);
    } else if (focusedSince === 0) {
      focusedSince = now;
    }
    const layoutHeight = Math.max(largestLayoutHeight, currentLayoutHeight);
    const keyboardHadTimeToOpen = textInputFocused && now - focusedSince > 120;
    const fallbackKeyboardInset =
      keyboardHadTimeToOpen && isLikelyTouchPhoneViewport()
        ? estimateKeyboardFallbackInset(layoutHeight)
        : 0;
    const inset = computeMobileKeyboardInset({
      innerHeight: window.innerHeight,
      layoutHeight,
      viewportHeight: viewport?.height ?? window.innerHeight,
      viewportOffsetTop: viewport?.offsetTop ?? 0,
      textInputFocused,
      fallbackKeyboardInset,
      composerBottom: getChatComposerBottom(),
      currentInset: readCurrentKeyboardInset(host),
      desiredGap: 8,
    });
    const composerHeight = getChatComposerHeight();
    const safeAreaBottom = readSafeAreaBottom();
    const visibleBottom = Math.max(
      0,
      Math.round((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)),
    );
    const padding = computeMobileComposerBottomPadding({
      composerHeight,
      keyboardInset: inset,
      safeAreaBottom,
      gap: 18,
    });
    writeRootPixelVar("--mobile-keyboard-inset", inset);
    writeRootPixelVar("--chat-composer-height", composerHeight);
    writeRootPixelVar("--chat-visible-bottom", visibleBottom);
    writeRootPixelVar("--chat-thread-bottom-padding", padding);
  };

  schedule = () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
    }
    frame = window.requestAnimationFrame(applyInset);
  };

  const delayedSchedule = () => {
    schedule();
    window.setTimeout(schedule, 80);
    window.setTimeout(schedule, 220);
  };

  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  document.addEventListener("focusin", delayedSchedule);
  document.addEventListener("focusout", delayedSchedule);
  schedule();

  host.mobileViewportCleanup = () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    observedComposer = null;
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("focusin", delayedSchedule);
    document.removeEventListener("focusout", delayedSchedule);
    for (const property of [
      "--mobile-keyboard-inset",
      "--chat-composer-height",
      "--chat-visible-bottom",
      "--chat-thread-bottom-padding",
    ]) {
      host.style.setProperty(property, "0px");
      document.documentElement.style.setProperty(property, "0px");
    }
    host.mobileViewportCleanup = null;
  };
}
