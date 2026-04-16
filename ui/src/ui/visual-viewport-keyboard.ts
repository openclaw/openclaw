/**
 * iOS Safari / WebKit (and some mobile browsers) keep `position: sticky` / bottom-anchored
 * composer chrome aligned to the *layout* viewport while the on-screen keyboard shrinks the
 * *visual* viewport, which hides the message field behind the keyboard (#36488).
 *
 * Expose the obscured region as `--visual-viewport-keyboard-inset` on `:root` so chat CSS can
 * lift the composer by that amount.
 */

const CSS_VAR = "--visual-viewport-keyboard-inset";

const TEXT_ENTRY_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

let cleanup: (() => void) | null = null;

/** @internal Exported for unit tests. */
export function computeVisualViewportKeyboardInsetPx(
  windowInnerHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
): number {
  const top = Math.max(0, visualViewportOffsetTop);
  return Math.max(0, Math.round(windowInnerHeight - visualViewportHeight - top));
}

/** @internal Exported for unit tests. */
export function isTextEditableElement(value: unknown): value is HTMLElement {
  if (typeof HTMLElement === "undefined") {
    return false;
  }
  if (!(value instanceof HTMLElement)) {
    return false;
  }
  if (value.isContentEditable) {
    return true;
  }
  if (value instanceof HTMLTextAreaElement) {
    return true;
  }
  if (value instanceof HTMLInputElement) {
    return !value.readOnly && !value.disabled && TEXT_ENTRY_INPUT_TYPES.has(value.type);
  }
  return false;
}

/** @internal Exported for unit tests. */
export function shouldApplyKeyboardInset(scale: number, hasEditableFocus: boolean): boolean {
  return scale === 1 && hasEditableFocus;
}

function applyInset(px: number) {
  document.documentElement.style.setProperty(CSS_VAR, `${px}px`);
}

function updateFromVisualViewport(vv: VisualViewport) {
  if (!shouldApplyKeyboardInset(vv.scale, isTextEditableElement(document.activeElement))) {
    applyInset(0);
    return;
  }
  applyInset(
    computeVisualViewportKeyboardInsetPx(window.innerHeight, vv.height, vv.offsetTop),
  );
}

/**
 * Installs visual viewport listeners and keeps `--visual-viewport-keyboard-inset` updated.
 * Safe to call multiple times; the previous installation is torn down first.
 */
export function installVisualViewportKeyboardInset() {
  if (typeof window === "undefined") {
    return;
  }
  const vv = window.visualViewport;
  if (!vv) {
    return;
  }

  uninstallVisualViewportKeyboardInset();

  const onChange = () => {
    updateFromVisualViewport(vv);
  };

  vv.addEventListener("resize", onChange);
  vv.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  onChange();

  cleanup = () => {
    vv.removeEventListener("resize", onChange);
    vv.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
    document.documentElement.style.removeProperty(CSS_VAR);
    cleanup = null;
  };
}

export function uninstallVisualViewportKeyboardInset() {
  cleanup?.();
}
